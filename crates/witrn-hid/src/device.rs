//! Opening a WITRN meter and unpacking the reports it streams.

use std::ffi::CStr;
use std::time::{Duration, Instant};

use chrono::Local;
use hidapi::{DeviceInfo, HidApi, HidDevice};
use usbpd_parser::Metadata;
use usbpd_parser::{ParseOptions, Parser, Sop};

use crate::error::{Error, Result};
use crate::general::{general_msg, REPORT_LEN};
use crate::info::{self, Identity};

/// WITRN's USB vendor ID, shared by every model.
pub const WITRN_VID: u16 = 0x0716;
/// Product ID of the WITRN K2, the default [`WitrnDev::open`] target.
pub const K2_PID: u16 = 0x5060;

/// How long [`WitrnDev::identity`] waits after a failed read before trying again.
const RETRY_BACKOFF: Duration = Duration::from_millis(10);

/// Where reports come from.
///
/// Crate-internal, and deliberately not part of the public API: it exists so the
/// read loop can be exercised against a source that fails, times out, or answers
/// somebody else, none of which can be arranged with real hardware in a test.
pub(crate) trait ReportSource {
    /// Fill `buf` with the next report, waiting at most `timeout_ms` if given.
    fn read_report(&self, buf: &mut [u8], timeout_ms: Option<i32>) -> Result<usize>;

    /// What USB enumeration says about this device.
    fn device_info(&self) -> Result<DeviceInfo>;
}

impl ReportSource for HidDevice {
    fn read_report(&self, buf: &mut [u8], timeout_ms: Option<i32>) -> Result<usize> {
        let len = match timeout_ms {
            Some(ms) => self.read_timeout(buf, ms)?,
            None => self.read(buf)?,
        };
        Ok(len)
    }

    fn device_info(&self) -> Result<DeviceInfo> {
        Ok(self.get_device_info()?)
    }
}

/// Which kind of report a 64-byte packet is, from its leading byte.
///
/// Marked `#[non_exhaustive]`: match with a `_` arm so a future report kind does not
/// break your build.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ReportKind {
    /// `0xFF` — a measurement sample.
    General,
    /// `0xFE` — a captured USB-PD message.
    Pd,
}

impl ReportKind {
    /// Classify a report, or `None` if the leading byte is neither `0xFF` nor `0xFE`.
    pub fn of(data: &[u8]) -> Option<Self> {
        match data.first()? {
            0xFF => Some(Self::General),
            0xFE => Some(Self::Pd),
            _ => None,
        }
    }
}

/// Decode a captured USB-PD (`0xFE`) report with caller-owned conversation state.
///
/// Keeping the parser outside [`WitrnDev`] lets an application retain its existing
/// HID ownership and connection lifecycle. Create one parser for each connection
/// and drop it on disconnect or reconnect.
pub fn decode_pd_report(parser: &mut Parser, data: &[u8]) -> Result<Metadata> {
    if data.len() < REPORT_LEN {
        return Err(Error::ShortReport { len: data.len() });
    }
    if data[0] != 0xFE {
        return Err(Error::UnknownReport { kind: data[0] });
    }

    // Byte 1 is the message length including the 2-byte report preamble; byte 2
    // names the ordered set that framed it.
    let sop = sop_of(data[2]).ok_or(Error::UnknownOrderedSet { byte: data[2] })?;
    let end = (data[1] as usize + 2).clamp(3, data.len());
    Ok(parser.parse(
        &data[3..end],
        ParseOptions {
            sop,
            verify_crc: false,
            prop_protocol: true,
            ..Default::default()
        },
    ))
}

/// A parsed report and the moment it was read.
///
/// The timestamp is local wall-clock at millisecond resolution, `"14:23:05.123"`.
pub type Unpacked = (String, Metadata);

/// A connected WITRN meter.
///
/// Open it, read 64-byte reports, and unpack them into a
/// [`Metadata`](usbpd_parser::Metadata) tree. PD reports are decoded by an embedded
/// [`Parser`], so `Source_Capabilities`/`Request` pairs and chunked extended messages
/// resolve across the stream without any bookkeeping on your side.
///
/// The device keeps only the *last* report read — it does not buffer a history. If
/// you need one, keep it yourself and pass context explicitly to
/// [`pd_unpack`](Self::pd_unpack).
///
/// ```no_run
/// use witrn_hid::WitrnDev;
///
/// let mut dev = WitrnDev::new();
/// dev.open()?;
/// loop {
///     dev.read_data()?;
///     let (at, msg) = dev.auto_unpack()?;
///     println!("{at} {}", msg.field());
/// }
/// # Ok::<_, witrn_hid::Error>(())
/// ```
pub struct WitrnDev {
    api: Option<HidApi>,
    device: Option<Box<dyn ReportSource>>,
    parser: Parser,
    data: Option<Vec<u8>>,
    timestamp: Option<String>,
    prop_protocol: bool,
}

impl Default for WitrnDev {
    fn default() -> Self {
        Self::new()
    }
}

impl WitrnDev {
    /// A device that is not yet connected.
    ///
    /// PD decoding starts in proprietary-protocol mode, which is what WITRN hardware
    /// reports; see [`set_prop_protocol`](Self::set_prop_protocol).
    pub fn new() -> Self {
        Self {
            api: None,
            device: None,
            parser: Parser::new(),
            data: None,
            timestamp: None,
            prop_protocol: true,
        }
    }

    /// Whether PPS objects are decoded with WITRN's widened field layout rather than
    /// the spec one.
    pub fn set_prop_protocol(&mut self, enabled: bool) -> &mut Self {
        self.prop_protocol = enabled;
        self
    }

    /// Every HID device WITRN has on this machine, for choosing between models.
    ///
    /// ```no_run
    /// use witrn_hid::WitrnDev;
    ///
    /// let mut dev = WitrnDev::new();
    /// for info in dev.list()? {
    ///     println!("{:04X}:{:04X} {:?}", info.vendor_id(), info.product_id(), info.product_string());
    /// }
    /// # Ok::<_, witrn_hid::Error>(())
    /// ```
    pub fn list(&mut self) -> Result<Vec<DeviceInfo>> {
        let api = self.api()?;
        Ok(api
            .device_list()
            .filter(|d| d.vendor_id() == WITRN_VID)
            .cloned()
            .collect())
    }

    /// Connect to a WITRN K2.
    pub fn open(&mut self) -> Result<()> {
        self.open_vid_pid(WITRN_VID, K2_PID)
    }

    /// Connect to a specific model by USB IDs.
    pub fn open_vid_pid(&mut self, vid: u16, pid: u16) -> Result<()> {
        let device = self.api()?.open(vid, pid)?;
        self.device = Some(Box::new(device));
        Ok(())
    }

    /// Connect by platform-specific HID path, for telling two identical meters apart.
    pub fn open_path(&mut self, path: &CStr) -> Result<()> {
        let device = self.api()?.open_path(path)?;
        self.device = Some(Box::new(device));
        Ok(())
    }

    /// Read the next complete report, blocking until one arrives.
    ///
    /// The report and the moment it arrived are kept until the next call, which is
    /// what the no-argument unpack methods use.
    pub fn read_data(&mut self) -> Result<&[u8]> {
        self.read_into(None)
    }

    /// Read the next report, giving up after `timeout_ms`.
    ///
    /// A timeout yields [`Error::ShortReport`] with a length of zero rather than
    /// blocking forever, so a polling loop can keep going.
    pub fn read_data_timeout(&mut self, timeout_ms: i32) -> Result<&[u8]> {
        self.read_into(Some(timeout_ms))
    }

    fn read_into(&mut self, timeout_ms: Option<i32>) -> Result<&[u8]> {
        let device = self.device.as_ref().ok_or(Error::NotOpen)?;
        let mut buf = vec![0u8; REPORT_LEN];
        let len = device.read_report(&mut buf, timeout_ms)?;
        buf.truncate(len.min(REPORT_LEN));

        self.timestamp = Some(now());
        self.data = Some(buf);
        Ok(self.data.as_deref().unwrap_or_default())
    }

    /// The report most recently read.
    pub fn data(&self) -> Option<&[u8]> {
        self.data.as_deref()
    }

    /// The PD parser holding the stream's conversation state.
    pub fn parser(&self) -> &Parser {
        &self.parser
    }

    /// Mutable access to the PD parser, e.g. to
    /// [`reset`](usbpd_parser::Parser::reset) it after a reconnect.
    pub fn parser_mut(&mut self) -> &mut Parser {
        &mut self.parser
    }

    /// Unpack a general measurement report.
    ///
    /// Pass `None` to use the stored report, which reports the time it was *read*;
    /// pass bytes of your own and the timestamp is the time of this call.
    pub fn general_unpack(&self, data: Option<&[u8]>) -> Result<Unpacked> {
        let (at, bytes) = self.subject(data)?;
        Ok((at, general_msg(bytes)?))
    }

    /// Identify the open meter, without writing anything to it.
    ///
    /// Combines what USB enumeration says — vendor, model, serial string, port —
    /// with the [`signature`](crate::info::signature) bytes out of its own
    /// stream. Reads reports until one arrives that is not carrying another
    /// program's reply, since those cannot be trusted for the signature; in
    /// practice that is the first one.
    ///
    /// ```no_run
    /// # use witrn_hid::WitrnDev;
    /// # let mut dev = WitrnDev::new();
    /// # dev.open()?;
    /// let id = dev.identity(2000)?;
    /// println!("{id}");                   // WITRN.K2 0716:5060 batch 20230727
    /// println!("{}", id.fingerprint());   // 0716:5060-20230727-340000200880060020
    /// # Ok::<_, witrn_hid::Error>(())
    /// ```
    pub fn identity(&mut self, timeout_ms: i32) -> Result<Identity> {
        let info = self.device.as_ref().ok_or(Error::NotOpen)?.device_info()?;
        let signature = self.wait_for_signature(timeout_ms)?;

        Ok(Identity {
            vendor_id: info.vendor_id(),
            product_id: info.product_id(),
            product: info.product_string().map(str::to_owned),
            usb_serial: info.serial_number().map(str::to_owned),
            path: info.path().to_string_lossy().into_owned(),
            signature,
        })
    }

    /// Read until a report arrives that can be trusted for the signature.
    ///
    /// Two different things can go wrong here and the caller needs to be told which:
    /// the transport failing, and the meter answering somebody else. Only the second
    /// is worth waiting out, so the first is remembered and returned at the deadline
    /// rather than discarded.
    fn wait_for_signature(&mut self, timeout_ms: i32) -> Result<[u8; info::SIGNATURE_LEN]> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms.max(0) as u64);
        let mut last_err = None;

        loop {
            let left = deadline
                .saturating_duration_since(Instant::now())
                .as_millis() as i32;
            if left <= 0 {
                return Err(last_err.unwrap_or(Error::NoData));
            }
            if let Err(err) = self.read_into(Some(left.max(1))) {
                last_err = Some(err);
                // An unplugged device fails immediately, so without this the loop
                // spins at full tilt until the deadline.
                std::thread::sleep(RETRY_BACKOFF);
                continue;
            }
            let Some(bytes) = self.data.as_deref() else {
                continue;
            };
            match info::signature(bytes) {
                // The identity block is carrying somebody's reply; try the next one.
                Ok(None) => continue,
                Ok(Some(signature)) => return Ok(signature),
                Err(err) => {
                    last_err = Some(err);
                    continue;
                }
            }
        }
    }

    /// Unpack a captured USB-PD report.
    ///
    /// With `data = None` the stored report is decoded against the device's own
    /// conversation state, which is then updated. Supplying `data` — and, if you keep
    /// your own message history, `last_pdo`/`last_ext`/`last_rdo` — decodes without
    /// touching that state.
    ///
    /// A report framed by an ordered set this crate does not recognise yields
    /// [`Error::UnknownOrderedSet`] rather than being decoded as if it were `SOP`.
    pub fn pd_unpack(
        &mut self,
        data: Option<&[u8]>,
        last_pdo: Option<&Metadata>,
        last_ext: Option<&Metadata>,
        last_rdo: Option<&Metadata>,
    ) -> Result<Unpacked> {
        let (at, bytes) = self.subject(data)?;
        let bytes = bytes.to_vec();

        // Byte 1 is the message length including the 2-byte report preamble; byte 2
        // names the ordered set that framed it.
        let sop = sop_of(bytes[2]).ok_or(Error::UnknownOrderedSet { byte: bytes[2] })?;
        let end = (bytes[1] as usize + 2).clamp(3, bytes.len());

        let msg = self.parser.parse(
            &bytes[3..end],
            ParseOptions {
                sop,
                verify_crc: false,
                prop_protocol: self.prop_protocol,
                last_pdo,
                last_ext,
                last_rdo,
            },
        );
        Ok((at, msg))
    }

    /// Unpack a report of either kind, dispatching on its leading byte.
    pub fn auto_unpack(&mut self) -> Result<Unpacked> {
        self.auto_unpack_data(None, None, None, None)
    }

    /// [`auto_unpack`](Self::auto_unpack) over bytes of your own.
    pub fn auto_unpack_data(
        &mut self,
        data: Option<&[u8]>,
        last_pdo: Option<&Metadata>,
        last_ext: Option<&Metadata>,
        last_rdo: Option<&Metadata>,
    ) -> Result<Unpacked> {
        let (_, bytes) = self.subject(data)?;
        match ReportKind::of(bytes) {
            Some(ReportKind::General) => self.general_unpack(data),
            Some(ReportKind::Pd) => self.pd_unpack(data, last_pdo, last_ext, last_rdo),
            None => Err(Error::UnknownReport { kind: bytes[0] }),
        }
    }

    /// Disconnect. The conversation state is kept; call
    /// [`Parser::reset`](usbpd_parser::Parser::reset) to clear it too.
    pub fn close(&mut self) {
        self.device = None;
    }

    /// Whether a device is currently open.
    pub fn is_open(&self) -> bool {
        self.device.is_some()
    }

    /// The bytes to unpack and the timestamp to report them under.
    fn subject<'a>(&'a self, data: Option<&'a [u8]>) -> Result<(String, &'a [u8])> {
        let (at, bytes) = match data {
            Some(bytes) => (now(), bytes),
            None => {
                let bytes = self.data.as_deref().ok_or(Error::NoData)?;
                (self.timestamp.clone().unwrap_or_else(now), bytes)
            }
        };
        if bytes.len() < REPORT_LEN {
            return Err(Error::ShortReport { len: bytes.len() });
        }
        Ok((at, bytes))
    }

    fn api(&mut self) -> Result<&HidApi> {
        if self.api.is_none() {
            self.api = Some(HidApi::new()?);
        }
        Ok(self.api.as_ref().expect("just initialised"))
    }

    /// A device backed by something other than real hardware.
    #[cfg(test)]
    fn with_source(source: Box<dyn ReportSource>) -> Self {
        Self {
            device: Some(source),
            ..Self::new()
        }
    }
}

/// Local wall-clock to the millisecond, matching the Python API's timestamps.
fn now() -> String {
    Local::now().format("%H:%M:%S%.3f").to_string()
}

/// The ordered set byte 2 of a PD report encodes.
///
/// `None` for a byte that names no ordered set. Guessing `SOP` there would not just
/// mislabel the message: the Message Header's role bits and the Discover Identity
/// product-type tables are both selected by the ordered set, so the fields under it
/// would be named and decoded wrongly with nothing to say so.
fn sop_of(byte: u8) -> Option<Sop> {
    match byte {
        224 => Some(Sop::Sop),
        192 => Some(Sop::SopPrime),
        160 => Some(Sop::SopDoublePrime),
        128 => Some(Sop::SopPrimeDebug),
        96 => Some(Sop::SopDoublePrimeDebug),
        // Continues the meter's 32-step SOP* encoding (224, 192, …, 96).
        64 => Some(Sop::HardReset),
        32 => Some(Sop::CableReset),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    /// A report source that answers from a script instead of from hardware.
    struct Fake {
        /// What each successive read should do.
        script: Vec<FakeRead>,
        /// Shared with the test, so it can see how hard the loop tried.
        calls: Rc<Cell<usize>>,
    }

    enum FakeRead {
        /// The transport failed.
        Fails,
        /// A report arrived.
        Gives(Vec<u8>),
    }

    impl Fake {
        /// Repeat one outcome for as long as anything keeps reading.
        fn always(read: FakeRead) -> (Box<dyn ReportSource>, Rc<Cell<usize>>) {
            Self::scripted(vec![read])
        }

        fn scripted(script: Vec<FakeRead>) -> (Box<dyn ReportSource>, Rc<Cell<usize>>) {
            let calls = Rc::new(Cell::new(0));
            let source = Box::new(Self {
                script,
                calls: Rc::clone(&calls),
            });
            (source, calls)
        }
    }

    impl ReportSource for Fake {
        fn read_report(&self, buf: &mut [u8], _timeout_ms: Option<i32>) -> Result<usize> {
            let n = self.calls.get();
            self.calls.set(n + 1);
            match &self.script[n.min(self.script.len() - 1)] {
                // A variant nothing in the read path produces on its own, so seeing
                // it come back out proves it was propagated rather than replaced.
                FakeRead::Fails => Err(Error::UnknownReport { kind: 0x99 }),
                FakeRead::Gives(report) => {
                    let len = report.len().min(buf.len());
                    buf[..len].copy_from_slice(&report[..len]);
                    Ok(len)
                }
            }
        }

        fn device_info(&self) -> Result<DeviceInfo> {
            Err(Error::NotOpen)
        }
    }

    fn general_report() -> Vec<u8> {
        let mut d = vec![0u8; REPORT_LEN];
        d[0] = 0xFF;
        d[46..50].copy_from_slice(&5.0f32.to_le_bytes());
        d
    }

    /// A K2 while it was answering another program: the identity block holds that
    /// reply, so the signature bytes are somebody else's payload.
    fn busy_report() -> Vec<u8> {
        let hex = "FF558777424713980A01500050005C29A5409DE89A425A1F0000870800003666223F\
                   D97C0E3F0000C8410000C8C20000000000000000001F2008800600209D23";
        (0..hex.len() / 2)
            .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap())
            .collect()
    }

    /// An idle K2, which does yield a signature.
    fn idle_report() -> Vec<u8> {
        let hex = "FF5592ACB3B548231A34000050005C29A5409DE89A425A1F00009214000043A0223F\
                   A09D0E3F0000C8410000C8C20000000000000000001E200880060020D53A";
        (0..hex.len() / 2)
            .map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap())
            .collect()
    }

    /// A PD report wrapping Source_Capabilities: 5 V / 3 A.
    fn pd_report() -> Vec<u8> {
        let msg = [0xA1u8, 0x11, 0x2C, 0x91, 0x01, 0x08];
        let mut d = vec![0u8; REPORT_LEN];
        d[0] = 0xFE;
        d[1] = msg.len() as u8 + 1; // length such that byte 1 + 2 ends the message
        d[2] = 224; // SOP
        d[3..3 + msg.len()].copy_from_slice(&msg);
        d
    }

    #[test]
    fn classifies_reports_by_their_leading_byte() {
        assert_eq!(ReportKind::of(&general_report()), Some(ReportKind::General));
        assert_eq!(ReportKind::of(&pd_report()), Some(ReportKind::Pd));
        assert_eq!(ReportKind::of(&[0x12]), None);
        assert_eq!(ReportKind::of(&[]), None);
    }

    #[test]
    fn unpacks_a_general_report_without_a_device() {
        let dev = WitrnDev::new();
        let (at, msg) = dev.general_unpack(Some(&general_report())).unwrap();
        assert_eq!(msg.get("VBus").unwrap().value().as_str(), Some("5.0V"));
        assert_eq!(at.len(), "00:00:00.000".len());
    }

    #[test]
    fn unpacks_a_pd_report_without_a_device() {
        let mut dev = WitrnDev::new();
        let (_, msg) = dev.pd_unpack(Some(&pd_report()), None, None, None).unwrap();
        assert_eq!(
            msg.get("Data Objects")
                .unwrap()
                .get("PDO 1")
                .unwrap()
                .quick_pdo(),
            Some("F 5.0V@3.0A")
        );
    }

    #[test]
    fn auto_unpack_dispatches_on_the_report_kind() {
        let mut dev = WitrnDev::new();
        let (_, general) = dev
            .auto_unpack_data(Some(&general_report()), None, None, None)
            .unwrap();
        assert_eq!(general.field(), "general");

        let (_, pd) = dev
            .auto_unpack_data(Some(&pd_report()), None, None, None)
            .unwrap();
        assert_eq!(pd.field(), "PD");
    }

    #[test]
    fn an_unrecognised_report_is_reported_rather_than_guessed() {
        let mut dev = WitrnDev::new();
        let mut junk = vec![0u8; REPORT_LEN];
        junk[0] = 0x42;
        assert!(matches!(
            dev.auto_unpack_data(Some(&junk), None, None, None),
            Err(Error::UnknownReport { kind: 0x42 })
        ));
    }

    #[test]
    fn short_reports_are_rejected() {
        let dev = WitrnDev::new();
        assert!(matches!(
            dev.general_unpack(Some(&[0xFF, 0x00])),
            Err(Error::ShortReport { len: 2 })
        ));
    }

    #[test]
    fn unpacking_before_reading_says_so() {
        let dev = WitrnDev::new();
        assert!(matches!(dev.general_unpack(None), Err(Error::NoData)));
    }

    #[test]
    fn reading_before_opening_says_so() {
        let mut dev = WitrnDev::new();
        assert!(matches!(dev.read_data(), Err(Error::NotOpen)));
        assert!(!dev.is_open());
    }

    #[test]
    fn sop_bytes_map_to_ordered_sets() {
        assert_eq!(sop_of(224), Some(Sop::Sop));
        assert_eq!(sop_of(192), Some(Sop::SopPrime));
        assert_eq!(sop_of(160), Some(Sop::SopDoublePrime));
        assert_eq!(sop_of(128), Some(Sop::SopPrimeDebug));
        assert_eq!(sop_of(96), Some(Sop::SopDoublePrimeDebug));
        assert_eq!(sop_of(64), Some(Sop::HardReset));
        assert_eq!(sop_of(32), Some(Sop::CableReset));
    }

    /// An unrecognised ordered set used to decode as `SOP`. That is not a cosmetic
    /// mislabel: the ordered set picks the Message Header's role fields and the
    /// Discover Identity product-type tables, so the message would come out with
    /// the wrong fields under it and nothing to say so.
    #[test]
    fn an_unknown_ordered_set_is_reported_rather_than_assumed_to_be_sop() {
        assert_eq!(sop_of(0), None);
        assert_eq!(sop_of(0x2A), None);

        let mut dev = WitrnDev::new();
        let mut report = pd_report();
        report[2] = 0x2A;
        assert!(matches!(
            dev.pd_unpack(Some(&report), None, None, None),
            Err(Error::UnknownOrderedSet { byte: 0x2A })
        ));
    }

    #[test]
    fn pd_state_carries_across_reports_from_the_stream() {
        let mut dev = WitrnDev::new();
        dev.pd_unpack(Some(&pd_report()), None, None, None).unwrap();
        assert!(dev.parser().last_pdo().is_some());
    }

    #[test]
    fn standalone_pd_decoder_keeps_caller_owned_context() {
        let mut parser = Parser::new();
        decode_pd_report(&mut parser, &pd_report()).unwrap();
        assert!(parser.last_pdo().is_some());
    }

    #[test]
    fn standalone_pd_decoder_rejects_general_and_unknown_ordered_sets() {
        let mut parser = Parser::new();
        let mut general = pd_report();
        general[0] = 0xFF;
        assert!(matches!(
            decode_pd_report(&mut parser, &general),
            Err(Error::UnknownReport { kind: 0xFF })
        ));

        let mut unknown = pd_report();
        unknown[2] = 0x2A;
        assert!(matches!(
            decode_pd_report(&mut parser, &unknown),
            Err(Error::UnknownOrderedSet { byte: 0x2A })
        ));
    }

    /// A failing read used to be discarded with `continue`, so the caller was told
    /// "no report has been read yet" for a device that was reporting a real error.
    #[test]
    fn waiting_for_a_signature_reports_the_transport_error() {
        let (source, _) = Fake::always(FakeRead::Fails);
        let mut dev = WitrnDev::with_source(source);
        assert!(matches!(
            dev.wait_for_signature(30),
            Err(Error::UnknownReport { kind: 0x99 })
        ));
    }

    /// ...and it used to spin at full tilt while doing it, because a device that is
    /// gone fails immediately rather than consuming the timeout.
    #[test]
    fn waiting_for_a_signature_backs_off_instead_of_spinning() {
        let (source, calls) = Fake::always(FakeRead::Fails);
        let mut dev = WitrnDev::with_source(source);

        let started = Instant::now();
        assert!(dev.wait_for_signature(100).is_err());
        let elapsed = started.elapsed();

        // 100 ms of back-off at 10 ms a turn is about ten reads. Without it this
        // loop managed hundreds of thousands.
        let made = calls.get();
        assert!(
            made <= 30,
            "{made} reads in {elapsed:?} — the loop is not backing off"
        );
    }

    /// A report whose identity block is carrying somebody else's reply is worth
    /// waiting past, unlike a transport error.
    #[test]
    fn waiting_for_a_signature_skips_reports_that_cannot_carry_one() {
        let (source, _) = Fake::scripted(vec![
            FakeRead::Gives(busy_report()),
            FakeRead::Gives(busy_report()),
            FakeRead::Gives(idle_report()),
        ]);
        let mut dev = WitrnDev::with_source(source);

        let signature = dev.wait_for_signature(1_000).unwrap();
        assert_eq!(
            signature,
            [0x34, 0x00, 0x00, 0x20, 0x08, 0x80, 0x06, 0x00, 0x20]
        );
    }

    /// A meter that never stops answering somebody else times out.
    #[test]
    fn a_meter_that_is_always_busy_times_out() {
        let (source, _) = Fake::always(FakeRead::Gives(busy_report()));
        let mut dev = WitrnDev::with_source(source);
        assert!(matches!(dev.wait_for_signature(30), Err(Error::NoData)));
    }
}

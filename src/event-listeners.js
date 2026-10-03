// @ts-check
/** Register independent listeners together; a partial failure releases every successful registration. */
/** @param {Promise<() => void>[]} registrations @returns {Promise<() => void>} */
export async function registerListeners(registrations) {
  const results = await Promise.allSettled(registrations);
  const release = () => {
    for (const result of results) {
      if (result.status === 'fulfilled') result.value();
    }
  };
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    release();
    throw failed.reason;
  }
  return release;
}

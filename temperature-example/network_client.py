import socket

def main():
    host = "127.0.0.1"  # 改成程序里“监听 IP”对应的地址
    port = 1573         # 改成程序里设置的端口

    with socket.create_connection((host, port), timeout=5) as s:
        # 持续读取：每行是一个温度数值（纯数字），例如：47.125\n
        buf = b""
        while True:
            chunk = s.recv(4096)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    temp = float(line.decode("utf-8"))
                except Exception:
                    # 如果你想调试，可打印原始行
                    # print("bad line:", line)
                    continue
                print(temp)


if __name__ == "__main__":
    main()

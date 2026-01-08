import socket
import random
import time

def main():
    host = "127.0.0.1"  # 监听地址
    port = 1573         # 监听端口

    # 创建服务器socket
    server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server_socket.bind((host, port))
    server_socket.listen(1)
    
    print(f"温度服务器启动，监听 {host}:{port}")
    
    while True:
        # 等待客户端连接
        print("等待客户端连接...")
        client_socket, client_address = server_socket.accept()
        print(f"客户端已连接: {client_address}")
        
        try:
            # 持续发送随机温度数据
            while True:
                # 生成0到100之间的随机温度（保留3位小数）
                temperature = round(random.uniform(0, 100), 3)
                
                # 发送格式：纯数字 + 换行符
                message = f"{temperature}\n"
                client_socket.sendall(message.encode("utf-8"))
                
                print(f"已发送温度: {temperature}")
                
                # 每秒发送一次数据
                time.sleep(1)
                
        except (BrokenPipeError, ConnectionResetError):
            print("客户端断开连接")
        except KeyboardInterrupt:
            print("\n服务器关闭")
            break
        finally:
            client_socket.close()
    
    server_socket.close()


if __name__ == "__main__":
    main()

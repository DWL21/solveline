"""컨테이너 헬스 체크: runner가 받는 곳(unix 소켓 또는 TCP)으로 GET /health."""
import http.client
import os
import socket
import sys

SOCKET_PATH = os.environ.get("RUNNER_SOCKET", "")


class UnixConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(SOCKET_PATH)


def main():
    if SOCKET_PATH:
        conn = UnixConnection("runner", timeout=4)
    else:
        conn = http.client.HTTPConnection("127.0.0.1", int(os.environ.get("PORT", "8000")), timeout=4)
    conn.request("GET", "/health")
    return 0 if conn.getresponse().status == 200 else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except OSError:
        sys.exit(1)

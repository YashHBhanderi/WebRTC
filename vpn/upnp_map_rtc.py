"""Map mediasoup RTC ports via UPnP (no router admin UI needed if IGD allows it)."""
import sys

try:
    import miniupnpc
except ImportError:
    print("miniupnpc missing")
    sys.exit(1)

MIN_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 40000
MAX_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 40020

u = miniupnpc.UPnP()
u.discoverdelay = 800
n = u.discover()
print(f"UPnP devices discovered: {n}")
if n <= 0:
    sys.exit(2)

try:
    u.selectigd()
except Exception as e:
    print(f"selectigd failed: {e}")
    sys.exit(3)

lan = u.lanaddr
ext = u.externalipaddress()
print(f"LAN={lan} EXT={ext}")

ok = 0
fail = 0
for port in range(MIN_PORT, MAX_PORT + 1):
    for proto in ("UDP", "TCP"):
        try:
            u.addportmapping(port, proto, lan, port, f"mediasoup-{proto}-{port}", "")
            print(f"OK {proto} {ext}:{port} -> {lan}:{port}")
            ok += 1
        except Exception as e:
            print(f"FAIL {proto} {port}: {e}")
            fail += 1

print(f"done ok={ok} fail={fail}")
print(ext)
sys.exit(0 if ok else 4)

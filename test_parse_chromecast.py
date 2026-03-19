import pychromecast
from pychromecast.discovery import CastBrowser, SimpleCastListener
import zeroconf
import time

class DummyCastListener(SimpleCastListener):
    def __init__(self):
        self.services = {}
    def add_cast(self, uuid, service):
        self.services[uuid] = service
        print("added", uuid)
    def remove_cast(self, uuid, service, cast_info):
        pass
    def update_cast(self, uuid, service):
        pass

# Force default (IPv4 only usually) to avoid OSError Errno 126 on missing multicast
zc = zeroconf.Zeroconf(interfaces=zeroconf.InterfaceChoice.Default)
listener = DummyCastListener()
browser = CastBrowser(listener, zeroconf_instance=zc)
browser.start_discovery()
time.sleep(1)
browser.stop_discovery()
zc.close()

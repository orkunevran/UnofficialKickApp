import pychromecast
import time

class SimpleListener:
    def __init__(self):
        self.devices = []
    def add_cast(self, uuid, service):
        print(f"Added {uuid} {service}")
    def remove_cast(self, uuid, service, cast_info):
        print(f"Removed {uuid}")
    def update_cast(self, uuid, service):
        pass

zconf = pychromecast.discovery.zeroconf.Zeroconf(interfaces=pychromecast.discovery.zeroconf.InterfaceChoice.All)
listener = SimpleListener()
browser = pychromecast.CastBrowser(listener, zconf)
browser.start_discovery()
time.sleep(2)
browser.stop_discovery()
zconf.close()

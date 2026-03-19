import pychromecast
import time
from pychromecast.discovery import SimpleCastListener, CastBrowser
import logging

logging.basicConfig(level=logging.INFO)

class MyListener(SimpleCastListener):
    def __init__(self, services):
        self.services = services
        
    def add_cast(self, uuid, service):
        print("Found:", uuid, service)
        self.services[uuid] = service
        
    def remove_cast(self, uuid, service, cast_info):
        pass
        
    def update_cast(self, uuid, service):
        pass

services = {}
listener = MyListener(services)

try:
    from pychromecast.discovery.zeroconf import Zeroconf, InterfaceChoice
    zc = Zeroconf(interfaces=InterfaceChoice.Default)
    browser = CastBrowser(listener, zconf=zc)
except Exception as e:
    browser = CastBrowser(listener)
    zc = None

browser.start_discovery()
time.sleep(3)
browser.stop_discovery()
if zc:
    zc.close()

casts = []
for uuid, service in services.items():
    cast = pychromecast.get_chromecast_from_cast_info(browser.devices[uuid], browser.zc)
    casts.append(cast)

print("Casts:", casts)

import pychromecast
import time
import sys

def discover_and_cast_direct():
    """
    Discovers Chromecast devices, prompts the user for a direct .m3u8 stream URL,
    and casts it to the selected device.
    """
    print("Discovering Chromecast devices...")
    try:
        chromecasts, browser = pychromecast.get_chromecasts(timeout=10)
    except pychromecast.error.NoChromecastFoundError:
        print("\nError: No Chromecast devices found on your network after 10 seconds.")
        print("Please ensure your Chromecast is on and connected to the same network.")
        sys.exit(1)

    if not chromecasts:
        print("No Chromecast devices were discovered.")
        return

    print("\nFound Chromecast devices:")
    for i, cc in enumerate(chromecasts):
        print(f"  [{i}] {cc.cast_info.friendly_name}")

    try:
        choice_str = input("\nSelect a device to cast to (enter the number): ")
        choice = int(choice_str)
        if not 0 <= choice < len(chromecasts):
            print("Error: Invalid selection.")
            return
    except (ValueError, EOFError, KeyboardInterrupt):
        print("\nInvalid input or selection cancelled. Exiting.")
        return

    cast = chromecasts[choice]
    cast.wait()
    print(f"\nSuccessfully connected to '{cast.cast_info.friendly_name}'")

    # Prompt for the direct .m3u8 URL
    stream_url = input("Enter the full Kick stream URL (.m3u8): ")
    if not stream_url.strip().endswith('.m3u8'):
        print("Warning: The URL does not end with .m3u8. It may not be a compatible HLS stream.")
    
    if not stream_url.strip():
        print("No URL entered. Exiting.")
        pychromecast.discovery.stop_discovery(browser)
        return

    print("\nStarting cast...")
    mc = cast.media_controller
    
    # The content type for HLS (m3u8) streams is 'application/vnd.apple.mpegurl' or 'application/x-mpegURL'
    mc.play_media(stream_url, "application/vnd.apple.mpegurl", title="Kick Stream")
    mc.block_until_active()
    
    print(f"Successfully casting to '{cast.cast_info.friendly_name}'")
    print("Press Ctrl+C to stop casting and exit.")

    try:
        # Keep the script alive while casting is active
        while mc.status.player_is_playing:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping cast...")
        mc.stop()
        print("Cast stopped.")
    finally:
        # Always stop discovery before exiting
        print("Stopping Chromecast discovery...")
        pychromecast.discovery.stop_discovery(browser)
        print("Exited.")

if __name__ == "__main__":
    try:
        discover_and_cast_direct()
    except KeyboardInterrupt:
        print("\nOperation cancelled by user. Exiting.")
    except Exception as e:
        print(f"\nAn unexpected error occurred: {e}")


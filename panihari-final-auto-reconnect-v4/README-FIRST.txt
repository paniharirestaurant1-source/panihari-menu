PANIHARI FINAL V4 - AUTO RECONNECT PRINTER

WEBSITE:
- Replace only index.html, owner.html and printer.js from WEBSITE_REPLACE_THESE_FILES in the existing live repo.
- Do NOT rename repo, site URL, QR paths or table QR URLs.
- Existing food/menu prices are not intentionally changed.

ANDROID APK SOURCE:
- Native Android printer bridge for Bluetooth Classic/SPP and USB OTG ESC/POS printers.
- First time: pair printer in Android Bluetooth settings, then open app > Printer > Bluetooth Classic / USB OTG > select printer.
- The selected Bluetooth MAC address (or USB vendor/product ID) is saved locally on the tablet.
- Next app launch: it automatically reconnects to the saved printer.
- If printer is OFF, app stays disconnected; turn printer ON and reopen app (or use Printer Connect).
- Disconnect does not erase the saved printer, so it can auto reconnect next time.
- Pairing removal, Android permission reset, or changing printer may require manual selection again.

NOTE:
The APK source needs to be built with Android/Gradle. The source includes GitHub Actions build workflow.

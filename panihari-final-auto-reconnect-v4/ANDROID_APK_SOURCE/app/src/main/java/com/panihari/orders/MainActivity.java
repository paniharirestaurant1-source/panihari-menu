package com.panihari.orders;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.PendingIntent;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothSocket;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.SharedPreferences;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.OutputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public class MainActivity extends Activity {
    private static final int REQ_BT = 4101;
    private static final String USB_PERMISSION = "com.panihari.orders.USB_PERMISSION";
    private WebView webView;
    private final PrinterBridge printerBridge = new PrinterBridge();
    private static final String PREFS = "panihari_printer";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setUserAgentString(s.getUserAgentString() + " PanihariOrdersApp/1.0");

        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient());
        webView.addJavascriptInterface(printerBridge, "VasukiPrinter");
        webView.loadUrl("file:///android_asset/owner.html");

        requestBluetoothPermissions();
    }

    private void requestBluetoothPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            List<String> missing = new ArrayList<>();
            if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED)
                missing.add(Manifest.permission.BLUETOOTH_CONNECT);
            if (checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED)
                missing.add(Manifest.permission.BLUETOOTH_SCAN);
            if (!missing.isEmpty()) requestPermissions(missing.toArray(new String[0]), REQ_BT);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack(); else super.onBackPressed();
    }

    public class PrinterBridge {
        private BluetoothSocket btSocket;
        private OutputStream btOutput;
        private UsbDeviceConnection usbConnection;
        private UsbEndpoint usbOut;
        private String connectedName = "";

        @JavascriptInterface
        public String connectPrinter() {
            final String[] choice = new String[1];
            CountDownLatch latch = new CountDownLatch(1);
            runOnUiThread(() -> new AlertDialog.Builder(MainActivity.this)
                    .setTitle("Connect Thermal Printer")
                    .setItems(new String[]{"Bluetooth Classic", "USB OTG"}, (d, which) -> {
                        choice[0] = which == 0 ? "bt" : "usb";
                        latch.countDown();
                    })
                    .setOnCancelListener(d -> latch.countDown())
                    .show());
            try { latch.await(60, TimeUnit.SECONDS); } catch (InterruptedException ignored) {}
            if (choice[0] == null) return "Cancelled";
            return "bt".equals(choice[0]) ? connectBluetooth() : connectUsb();
        }

        private String connectBluetooth() {
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S &&
                        checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                    runOnUiThread(MainActivity.this::requestBluetoothPermissions);
                    return "Bluetooth permission needed - allow it and tap connect again";
                }
                BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
                if (adapter == null) return "Bluetooth not supported";
                if (!adapter.isEnabled()) return "Turn Bluetooth ON first";

                Set<BluetoothDevice> bonded = adapter.getBondedDevices();
                if (bonded == null || bonded.isEmpty()) return "Pair printer in tablet Bluetooth settings first";
                List<BluetoothDevice> devices = new ArrayList<>(bonded);
                String[] names = new String[devices.size()];
                for (int i = 0; i < devices.size(); i++) {
                    String n = devices.get(i).getName();
                    names[i] = (n == null || n.trim().isEmpty() ? "Bluetooth device" : n) + "\n" + devices.get(i).getAddress();
                }

                final int[] selected = {-1};
                CountDownLatch latch = new CountDownLatch(1);
                runOnUiThread(() -> new AlertDialog.Builder(MainActivity.this)
                        .setTitle("Select paired printer")
                        .setItems(names, (d, which) -> { selected[0] = which; latch.countDown(); })
                        .setOnCancelListener(d -> latch.countDown())
                        .show());
                latch.await(60, TimeUnit.SECONDS);
                if (selected[0] < 0) return "Cancelled";

                closeConnections();
                BluetoothDevice device = devices.get(selected[0]);
                UUID spp = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
                adapter.cancelDiscovery();
                try {
                    btSocket = device.createRfcommSocketToServiceRecord(spp);
                    btSocket.connect();
                } catch (Exception first) {
                    try { if (btSocket != null) btSocket.close(); } catch (Exception ignored) {}
                    btSocket = device.createInsecureRfcommSocketToServiceRecord(spp);
                    btSocket.connect();
                }
                btOutput = btSocket.getOutputStream();
                connectedName = device.getName() == null ? "Bluetooth Printer" : device.getName();
                getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                        .putString("type", "bt")
                        .putString("bt_mac", device.getAddress())
                        .putString("name", connectedName)
                        .apply();
                return connectedName;
            } catch (Exception e) {
                closeConnections();
                return "Bluetooth error: " + safeMessage(e);
            }
        }

        private String connectUsb() {
            try {
                UsbManager manager = (UsbManager) getSystemService(Context.USB_SERVICE);
                List<UsbDevice> devices = new ArrayList<>(manager.getDeviceList().values());
                if (devices.isEmpty()) return "Connect USB printer with OTG cable first";
                String[] names = new String[devices.size()];
                for (int i = 0; i < devices.size(); i++) {
                    UsbDevice d = devices.get(i);
                    names[i] = (d.getProductName() == null ? "USB Printer" : d.getProductName()) +
                            " (" + d.getVendorId() + ":" + d.getProductId() + ")";
                }

                final int[] selected = {-1};
                CountDownLatch selectLatch = new CountDownLatch(1);
                runOnUiThread(() -> new AlertDialog.Builder(MainActivity.this)
                        .setTitle("Select USB printer")
                        .setItems(names, (d, which) -> { selected[0] = which; selectLatch.countDown(); })
                        .setOnCancelListener(d -> selectLatch.countDown())
                        .show());
                selectLatch.await(60, TimeUnit.SECONDS);
                if (selected[0] < 0) return "Cancelled";
                UsbDevice device = devices.get(selected[0]);

                if (!manager.hasPermission(device)) {
                    CountDownLatch permissionLatch = new CountDownLatch(1);
                    final boolean[] granted = {false};
                    BroadcastReceiver receiver = new BroadcastReceiver() {
                        @Override public void onReceive(Context context, Intent intent) {
                            if (USB_PERMISSION.equals(intent.getAction())) {
                                granted[0] = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
                                permissionLatch.countDown();
                            }
                        }
                    };
                    IntentFilter filter = new IntentFilter(USB_PERMISSION);
                    if (Build.VERSION.SDK_INT >= 33) registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
                    else registerReceiver(receiver, filter);
                    int flags = PendingIntent.FLAG_UPDATE_CURRENT;
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_MUTABLE;
                    PendingIntent pi = PendingIntent.getBroadcast(MainActivity.this, 0, new Intent(USB_PERMISSION), flags);
                    manager.requestPermission(device, pi);
                    permissionLatch.await(60, TimeUnit.SECONDS);
                    try { unregisterReceiver(receiver); } catch (Exception ignored) {}
                    if (!granted[0]) return "USB permission denied";
                }

                UsbInterface iface = null;
                UsbEndpoint out = null;
                for (int i = 0; i < device.getInterfaceCount() && out == null; i++) {
                    UsbInterface candidate = device.getInterface(i);
                    for (int e = 0; e < candidate.getEndpointCount(); e++) {
                        UsbEndpoint ep = candidate.getEndpoint(e);
                        if (ep.getDirection() == UsbConstants.USB_DIR_OUT && ep.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK) {
                            iface = candidate; out = ep; break;
                        }
                    }
                }
                if (iface == null || out == null) return "USB printer has no bulk OUT endpoint";

                closeConnections();
                usbConnection = manager.openDevice(device);
                if (usbConnection == null) return "Unable to open USB printer";
                if (!usbConnection.claimInterface(iface, true)) return "Unable to claim USB printer interface";
                usbOut = out;
                connectedName = device.getProductName() == null ? "USB Printer" : device.getProductName();
                getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                        .putString("type", "usb")
                        .putInt("usb_vendor", device.getVendorId())
                        .putInt("usb_product", device.getProductId())
                        .putString("name", connectedName)
                        .apply();
                return connectedName;
            } catch (Exception e) {
                closeConnections();
                return "USB error: " + safeMessage(e);
            }
        }


        @JavascriptInterface
        public String autoReconnectPrinter() {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            String type = sp.getString("type", "");
            if ("bt".equals(type)) return reconnectBluetooth(sp.getString("bt_mac", ""));
            if ("usb".equals(type)) return reconnectUsb(sp.getInt("usb_vendor", -1), sp.getInt("usb_product", -1));
            return "NO_SAVED_PRINTER";
        }

        private String reconnectBluetooth(String mac) {
            try {
                if (mac == null || mac.isEmpty()) return "NO_SAVED_PRINTER";
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) return "PERMISSION_REQUIRED";
                BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
                if (adapter == null || !adapter.isEnabled()) return "BLUETOOTH_OFF";
                BluetoothDevice device = adapter.getRemoteDevice(mac);
                closeConnections();
                UUID spp = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");
                try { btSocket = device.createRfcommSocketToServiceRecord(spp); btSocket.connect(); }
                catch (Exception first) { try { if (btSocket != null) btSocket.close(); } catch (Exception ignored) {} btSocket = device.createInsecureRfcommSocketToServiceRecord(spp); btSocket.connect(); }
                btOutput = btSocket.getOutputStream();
                connectedName = device.getName() == null ? "Bluetooth Printer" : device.getName();
                return connectedName;
            } catch (Exception e) { closeConnections(); return "RECONNECT_FAILED: " + safeMessage(e); }
        }

        private String reconnectUsb(int vendorId, int productId) {
            try {
                UsbManager manager = (UsbManager) getSystemService(Context.USB_SERVICE);
                UsbDevice target = null;
                for (UsbDevice d : manager.getDeviceList().values()) if (d.getVendorId() == vendorId && d.getProductId() == productId) { target = d; break; }
                if (target == null) return "USB_NOT_CONNECTED";
                if (!manager.hasPermission(target)) return "USB_PERMISSION_REQUIRED";
                UsbInterface iface = null; UsbEndpoint out = null;
                for (int i=0;i<target.getInterfaceCount() && out==null;i++) { UsbInterface c=target.getInterface(i); for(int e=0;e<c.getEndpointCount();e++){ UsbEndpoint ep=c.getEndpoint(e); if(ep.getDirection()==UsbConstants.USB_DIR_OUT && ep.getType()==UsbConstants.USB_ENDPOINT_XFER_BULK){ iface=c; out=ep; break; } } }
                if (iface == null || out == null) return "USB_ENDPOINT_NOT_FOUND";
                closeConnections(); usbConnection = manager.openDevice(target);
                if (usbConnection == null || !usbConnection.claimInterface(iface, true)) return "USB_OPEN_FAILED";
                usbOut = out; connectedName = target.getProductName() == null ? "USB Printer" : target.getProductName();
                return connectedName;
            } catch (Exception e) { closeConnections(); return "RECONNECT_FAILED: " + safeMessage(e); }
        }

        @JavascriptInterface
        public String printBase64(String base64) {
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                if (btOutput != null) {
                    btOutput.write(data);
                    btOutput.flush();
                    return "OK";
                }
                if (usbConnection != null && usbOut != null) {
                    int offset = 0;
                    while (offset < data.length) {
                        int len = Math.min(4096, data.length - offset);
                        byte[] chunk = new byte[len];
                        System.arraycopy(data, offset, chunk, 0, len);
                        int sent = usbConnection.bulkTransfer(usbOut, chunk, len, 5000);
                        if (sent < 0) throw new Exception("USB transfer failed");
                        offset += len;
                    }
                    return "OK";
                }
                return "Printer not connected";
            } catch (Exception e) {
                return "Print error: " + safeMessage(e);
            }
        }

        @JavascriptInterface
        public String printText(String text) {
            return printBase64(Base64.encodeToString(text.getBytes(), Base64.NO_WRAP));
        }

        @JavascriptInterface
        public String disconnectPrinter() {
            closeConnections();
            connectedName = "";
            return "Disconnected";
        }

        @JavascriptInterface
        public String forgetSavedPrinter() {
            closeConnections(); connectedName = "";
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().clear().apply();
            return "Forgotten";
        }

        @JavascriptInterface
        public String getConnectedPrinter() {
            return connectedName;
        }

        private void closeConnections() {
            try { if (btOutput != null) btOutput.close(); } catch (Exception ignored) {}
            try { if (btSocket != null) btSocket.close(); } catch (Exception ignored) {}
            try { if (usbConnection != null) usbConnection.close(); } catch (Exception ignored) {}
            btOutput = null; btSocket = null; usbConnection = null; usbOut = null;
        }

        private String safeMessage(Exception e) {
            return e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
        }
    }
}

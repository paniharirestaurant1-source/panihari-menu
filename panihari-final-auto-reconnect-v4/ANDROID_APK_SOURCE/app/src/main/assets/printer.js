/* PANIHARI Universal Thermal Printer Adapter
   Supports: Android native bridge (Bluetooth Classic/USB OTG), Web Serial USB,
   WebUSB bulk printers, Web Bluetooth BLE, and browser print fallback.
*/
(function () {
  'use strict';

  const ESC = 0x1b, GS = 0x1d;
  const enc = new TextEncoder();
  const state = {
    type: localStorage.getItem('panihariPrinterType') || '',
    connected: false,
    autoPrint: localStorage.getItem('panihariAutoPrint') === '1',
    serialPort: null,
    usbDevice: null,
    usbInterface: null,
    usbEndpoint: null,
    bleDevice: null,
    bleCharacteristic: null,
    name: localStorage.getItem('panihariPrinterName') || ''
  };

  function bytes(...arrays) {
    const flat = [];
    arrays.forEach(a => flat.push(...(a instanceof Uint8Array ? Array.from(a) : a)));
    return new Uint8Array(flat);
  }

  function cleanText(value) {
    return String(value ?? '')
      .normalize('NFKD')
      .replace(/[^\x20-\x7E]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function line(left, right = '', width = 32) {
    left = cleanText(left); right = cleanText(right);
    if (!right) return left.slice(0, width).padEnd(width, ' ');
    const maxLeft = Math.max(1, width - right.length - 1);
    left = left.slice(0, maxLeft);
    const spaces = Math.max(1, width - left.length - right.length);
    return left + ' '.repeat(spaces) + right;
  }

  function money(v) { return 'Rs.' + Number(v || 0).toFixed(0); }

  function buildOrder(order, orderId) {
    const width = 32;
    const out = [];
    out.push([ESC, 0x40]); // init
    out.push([ESC, 0x61, 0x01]); // center
    out.push([ESC, 0x45, 0x01]); // bold on
    out.push(enc.encode('PANIHARI\n'));
    out.push(enc.encode('KITCHEN ORDER / KOT\n'));
    out.push([ESC, 0x45, 0x00]);
    out.push([ESC, 0x61, 0x00]); // left
    out.push(enc.encode('-'.repeat(width) + '\n'));
    out.push(enc.encode(line('TABLE', String(order.table || '?'), width) + '\n'));
    if (orderId) out.push(enc.encode(line('ORDER', String(orderId).slice(-8), width) + '\n'));
    try {
      const d = new Date(order.time || Date.now());
      out.push(enc.encode(line('TIME', d.toLocaleString('en-IN'), width) + '\n'));
    } catch (_) {}
    out.push(enc.encode('-'.repeat(width) + '\n'));
    out.push([ESC, 0x45, 0x01]);
    out.push(enc.encode(line('ITEM', 'QTY', width) + '\n'));
    out.push([ESC, 0x45, 0x00]);
    (order.items || []).forEach(item => {
      const qty = Number(item.qty || 1);
      const name = cleanText(item.name || 'Item');
      // Wrap item names for narrow 58mm printers.
      const first = name.slice(0, 26);
      out.push(enc.encode(line(first, 'x' + qty, width) + '\n'));
      let rest = name.slice(26);
      while (rest) {
        out.push(enc.encode(rest.slice(0, width) + '\n'));
        rest = rest.slice(width);
      }
    });
    out.push(enc.encode('-'.repeat(width) + '\n'));
    if (order.subtotal != null) out.push(enc.encode(line('Subtotal', money(order.subtotal), width) + '\n'));
    if (order.gst != null) out.push(enc.encode(line('GST', money(order.gst), width) + '\n'));
    out.push([ESC, 0x45, 0x01]);
    out.push(enc.encode(line('TOTAL', money(order.total), width) + '\n'));
    out.push([ESC, 0x45, 0x00]);
    out.push(enc.encode('\n\n'));
    out.push([GS, 0x56, 0x42, 0x00]); // cut if supported; harmless otherwise
    return bytes(...out);
  }

  async function writeChunked(writer, data, chunk = 128) {
    for (let i = 0; i < data.length; i += chunk) {
      await writer(data.slice(i, i + chunk));
      await new Promise(r => setTimeout(r, 15));
    }
  }

  function hasNativeBridge() {
    return !!(window.VasukiPrinter && (window.VasukiPrinter.printBase64 || window.VasukiPrinter.printText));
  }

  async function connectNative(silent = false) {
    if (!hasNativeBridge()) throw new Error('Android printer bridge is not available in this browser.');
    let result = '';
    if (silent && window.VasukiPrinter.autoReconnectPrinter) result = String(window.VasukiPrinter.autoReconnectPrinter() || '');
    else if (window.VasukiPrinter.connectPrinter) result = String(window.VasukiPrinter.connectPrinter() || '');
    else result = 'Android Printer';
    if (!result || /^(NO_SAVED_PRINTER|PERMISSION_REQUIRED|BLUETOOTH_OFF|USB_NOT_CONNECTED|USB_PERMISSION_REQUIRED|USB_ENDPOINT_NOT_FOUND|USB_OPEN_FAILED|RECONNECT_FAILED)/.test(result)) {
      if (silent) return false;
      throw new Error(result || 'Printer connection failed');
    }
    state.name = result; state.type = 'native'; state.connected = true;
    localStorage.setItem('panihariPrinterType', 'native');
    localStorage.setItem('panihariPrinterName', state.name);
    updateUI();
    return true;
  }

  async function autoReconnectSavedPrinter() {
    if (!hasNativeBridge()) return false;
    try {
      const ok = await connectNative(true);
      if (ok) { setPanelMessage('Auto connected: ' + state.name, 'ok'); toast('Printer auto-connected: ' + state.name); }
      return ok;
    } catch (_) { return false; }
  }

  async function connectSerial() {
    if (!('serial' in navigator)) throw new Error('USB Serial printing needs Chrome/Edge on Android/PC.');
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 9600 }).catch(async () => {
      try { await port.open({ baudRate: 115200 }); } catch (e) { throw e; }
    });
    state.serialPort = port; state.type = 'serial'; state.connected = true; state.name = 'USB Serial Printer';
  }

  async function connectUSB() {
    if (!('usb' in navigator)) throw new Error('WebUSB is not supported in this browser.');
    const device = await navigator.usb.requestDevice({ filters: [] });
    await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    let found = null;
    for (const iface of device.configuration.interfaces) {
      for (const alt of iface.alternates) {
        const ep = alt.endpoints.find(e => e.direction === 'out' && e.type === 'bulk');
        if (ep) { found = { iface, alt, ep }; break; }
      }
      if (found) break;
    }
    if (!found) throw new Error('No USB bulk OUT endpoint found on this printer.');
    await device.claimInterface(found.iface.interfaceNumber);
    if (found.iface.alternate.alternateSetting !== found.alt.alternateSetting) {
      await device.selectAlternateInterface(found.iface.interfaceNumber, found.alt.alternateSetting);
    }
    state.usbDevice = device;
    state.usbInterface = found.iface.interfaceNumber;
    state.usbEndpoint = found.ep.endpointNumber;
    state.type = 'usb'; state.connected = true; state.name = device.productName || 'USB Printer';
  }

  async function connectBLE() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth is not supported in this browser.');
    // acceptAllDevices allows common BLE thermal printers; services are discovered after pairing.
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [
        '000018f0-0000-1000-8000-00805f9b34fb',
        '0000ff00-0000-1000-8000-00805f9b34fb',
        '0000ffe0-0000-1000-8000-00805f9b34fb',
        '0000ae30-0000-1000-8000-00805f9b34fb'
      ]
    });
    const server = await device.gatt.connect();
    const services = await server.getPrimaryServices();
    let characteristic = null;
    for (const service of services) {
      const chars = await service.getCharacteristics();
      characteristic = chars.find(c => c.properties.writeWithoutResponse || c.properties.write);
      if (characteristic) break;
    }
    if (!characteristic) throw new Error('No writable BLE characteristic found. This may be a Bluetooth Classic printer.');
    state.bleDevice = device; state.bleCharacteristic = characteristic;
    state.type = 'ble'; state.connected = true; state.name = device.name || 'Bluetooth BLE Printer';
    device.addEventListener('gattserverdisconnected', () => { state.connected = false; updateUI(); });
  }

  function setPanelMessage(message, tone = 'info') {
    const el = document.getElementById('printerHelpMessage');
    if (!el) return;
    const palette = {
      info: ['rgba(212,175,55,.07)', '#bbb', 'rgba(212,175,55,.16)'],
      ok: ['rgba(16,185,129,.10)', '#9ff0cf', 'rgba(16,185,129,.30)'],
      warn: ['rgba(245,158,11,.10)', '#f6d98b', 'rgba(245,158,11,.30)'],
      error: ['rgba(239,68,68,.10)', '#ffb4b4', 'rgba(239,68,68,.30)']
    };
    const c = palette[tone] || palette.info;
    el.style.background = c[0]; el.style.color = c[1]; el.style.border = '1px solid ' + c[2];
    el.textContent = message;
  }

  async function connect(type) {
    type = type || state.type || 'auto';
    try {
      if (type === 'auto') {
        if (hasNativeBridge()) type = 'native';
        else if ('serial' in navigator) type = 'serial';
        else if (navigator.bluetooth) type = 'ble';
        else type = 'browser';
      }
      if (type === 'native') {
        if (!hasNativeBridge()) {
          setPanelMessage('Bluetooth Classic / Table-Vyapar printer normal Chrome page se direct connect nahi hota. Is mode ke liye Android printer app/bridge chahiye. Phone me printer ko Bluetooth settings se pair karke APK me owner panel kholna hoga.', 'warn');
          throw new Error('Android printer bridge is not installed/open.');
        }
        await connectNative();
      }
      else if (type === 'serial') await connectSerial();
      else if (type === 'usb') await connectUSB();
      else if (type === 'ble') await connectBLE();
      else { state.type = 'browser'; state.connected = true; state.name = 'Browser Print'; }
      localStorage.setItem('panihariPrinterType', state.type);
      localStorage.setItem('panihariPrinterName', state.name);
      updateUI();
      setPanelMessage('Connected: ' + state.name + '. Ab TEST PRINT chala sakte ho.', 'ok');
      toast('Printer connected: ' + state.name);
      return true;
    } catch (e) {
      console.error('[Printer connect]', e);
      state.connected = false; updateUI();
      if (type !== 'native') setPanelMessage('Connection failed: ' + e.message, 'error');
      alert('Printer connection failed:\n' + e.message + '\n\nBluetooth Classic printers need the Android app/bridge mode.');
      return false;
    }
  }

  function toBase64(uint8) {
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < uint8.length; i += step) {
      binary += String.fromCharCode(...uint8.subarray(i, i + step));
    }
    return btoa(binary);
  }

  async function sendRaw(data) {
    if (!state.connected && state.type !== 'native') throw new Error('Printer is not connected.');
    if (state.type === 'native') {
      if (!hasNativeBridge()) throw new Error('Android bridge unavailable.');
      if (window.VasukiPrinter.printBase64) window.VasukiPrinter.printBase64(toBase64(data));
      else window.VasukiPrinter.printText(new TextDecoder().decode(data));
      return;
    }
    if (state.type === 'serial') {
      const writer = state.serialPort.writable.getWriter();
      try { await writeChunked(chunk => writer.write(chunk), data, 512); } finally { writer.releaseLock(); }
      return;
    }
    if (state.type === 'usb') {
      await writeChunked(chunk => state.usbDevice.transferOut(state.usbEndpoint, chunk), data, 1024);
      return;
    }
    if (state.type === 'ble') {
      const c = state.bleCharacteristic;
      const write = c.properties.writeWithoutResponse && c.writeValueWithoutResponse
        ? chunk => c.writeValueWithoutResponse(chunk)
        : chunk => c.writeValue(chunk);
      await writeChunked(write, data, 120);
      return;
    }
    throw new Error('Raw printing is not available in browser fallback mode.');
  }

  function browserPrint(order, orderId) {
    const items = (order.items || []).map(i => `<tr><td>${escapeHtml(i.name || 'Item')}</td><td style="text-align:center">${i.qty || 1}</td><td style="text-align:right">${money(i.sub || (i.price * i.qty) || 0)}</td></tr>`).join('');
    const w = window.open('', '_blank', 'width=420,height=650');
    if (!w) throw new Error('Popup blocked. Allow popups for printing.');
    w.document.write(`<!doctype html><html><head><title>KOT</title><style>body{font-family:monospace;width:72mm;margin:3mm;font-size:12px}h2,p{margin:2px;text-align:center}table{width:100%;border-collapse:collapse}td{padding:3px 0;border-bottom:1px dashed #999}.r{text-align:right}.big{font-size:17px;font-weight:bold}@media print{@page{margin:2mm}}</style></head><body><h2>PANIHARI</h2><p>KITCHEN ORDER / KOT</p><hr><div class="big">TABLE ${escapeHtml(order.table || '?')}</div><div>Order: ${escapeHtml(String(orderId || '').slice(-8))}</div><hr><table>${items}</table><hr><div class="r big">TOTAL ${money(order.total)}</div><script>onload=()=>{print();setTimeout(()=>close(),600)}<\/script></body></html>`);
    w.document.close();
  }

  function escapeHtml(v) { return String(v).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

  async function printOrder(orderId, order) {
    order = order || (window.allOrders && window.allOrders[orderId]);
    if (!order) throw new Error('Order not found.');
    try {
      if (!state.connected) {
        const saved = localStorage.getItem('panihariPrinterType');
        if (saved === 'native' && hasNativeBridge()) await connectNative();
        else throw new Error('Connect a printer first.');
      }
      if (state.type === 'browser') browserPrint(order, orderId);
      else await sendRaw(buildOrder(order, orderId));
      toast('KOT printed - Table ' + (order.table || '?'));
      return true;
    } catch (e) {
      console.error('[Print]', e);
      alert('Print failed: ' + e.message);
      return false;
    }
  }

  async function testPrint() {
    const test = { table: 'TEST', time: new Date().toISOString(), items: [{name:'Printer Test',qty:1,price:0,sub:0}], subtotal:0, gst:0, total:0 };
    return printOrder('TEST0001', test);
  }

  async function autoPrintOrder(orderId, order) {
    if (!state.autoPrint) return;
    if (!state.connected && !(state.type === 'native' && hasNativeBridge())) {
      toast('New order: printer not connected');
      return;
    }
    await printOrder(orderId, order);
  }

  function setAutoPrint(enabled) {
    state.autoPrint = !!enabled;
    localStorage.setItem('panihariAutoPrint', state.autoPrint ? '1' : '0');
    updateUI();
    toast('Auto Print ' + (state.autoPrint ? 'ON' : 'OFF'));
  }

  function disconnect() {
    try {
      if (state.serialPort) state.serialPort.close();
      if (state.usbDevice && state.usbDevice.opened) state.usbDevice.close();
      if (state.bleDevice && state.bleDevice.gatt.connected) state.bleDevice.gatt.disconnect();
      if (hasNativeBridge() && window.VasukiPrinter.disconnectPrinter) window.VasukiPrinter.disconnectPrinter();
    } catch (_) {}
    state.connected = false; state.serialPort = null; state.usbDevice = null; state.bleCharacteristic = null;
    updateUI(); toast('Printer disconnected');
  }

  function toast(msg) {
    if (typeof window.showToast === 'function') window.showToast(msg);
    else console.log(msg);
  }

  function injectUI() {
    const headerActions = document.querySelector('header .flex.items-center.gap-3:last-child');
    if (headerActions) {
      const wrap = document.createElement('div');
      wrap.className = 'flex items-center gap-2 flex-wrap';
      wrap.innerHTML = `
        <button id="printerConnectBtn" onclick="UniversalPrinter.openPanel()" class="btn-clear" style="border-color:rgba(212,175,55,.45);color:var(--gold)">
          <i class="fas fa-print mr-2"></i><span id="printerBtnText">PRINTER</span>
        </button>
        <label class="flex items-center gap-2 text-xs text-white/60 px-2 cursor-pointer" title="Print KOT automatically when a new order arrives">
          <input id="autoPrintToggle" type="checkbox" onchange="UniversalPrinter.setAutoPrint(this.checked)" class="accent-yellow-500"> AUTO PRINT
        </label>`;
      headerActions.prepend(wrap);
    }

    const modal = document.createElement('div');
    modal.id = 'printerModal';
    modal.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.82);backdrop-filter:blur(8px);align-items:center;justify-content:center;padding:16px';
    modal.innerHTML = `
      <div style="width:min(560px,100%);background:#111;border:1px solid rgba(212,175,55,.35);border-radius:22px;padding:22px;color:#fff;box-shadow:0 25px 80px #000">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:16px">
          <div><h2 style="color:#D4AF37;font-size:20px;font-weight:800">Printer Setup</h2><p id="printerStatus" style="font-size:12px;color:#888;margin-top:3px">Not connected</p></div>
          <button onclick="UniversalPrinter.closePanel()" style="font-size:24px;color:#aaa">&times;</button>
        </div>
        <p style="font-size:12px;color:#aaa;margin-bottom:14px;line-height:1.5">Choose how your thermal printer is connected. 58mm and 80mm ESC/POS printers are supported.</p>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <button onclick="UniversalPrinter.connect('native')" class="printer-choice"><b>Bluetooth Classic / USB OTG</b><small>Android app bridge — best for Table/Vyapar & most portable printers</small></button>
          <button onclick="UniversalPrinter.connect('ble')" class="printer-choice"><b>Bluetooth BLE</b><small>BLE thermal printers supported by Chrome</small></button>
          <button onclick="UniversalPrinter.connect('serial')" class="printer-choice"><b>USB / Serial</b><small>USB serial ESC/POS printers</small></button>
          <button onclick="UniversalPrinter.connect('usb')" class="printer-choice"><b>USB Direct</b><small>WebUSB bulk-compatible printers</small></button>
          <button onclick="UniversalPrinter.connect('browser')" class="printer-choice" style="grid-column:1/-1"><b>System Print</b><small>Fallback: use Android/Windows print dialog</small></button>
        </div>
        <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap">
          <button onclick="UniversalPrinter.testPrint()" class="btn-clear"><i class="fas fa-receipt mr-1"></i> TEST PRINT</button>
          <button onclick="UniversalPrinter.disconnect()" class="btn-delete"><i class="fas fa-plug-circle-xmark mr-1"></i> DISCONNECT</button>
        </div>
        <div id="printerHelpMessage" style="margin-top:14px;padding:10px 12px;border-radius:12px;background:rgba(212,175,55,.07);border:1px solid rgba(212,175,55,.16);font-size:11px;color:#bbb;line-height:1.45">
          Select a connection type. Table/Vyapar jaise Bluetooth Classic printers ke liye Android app/bridge mode use karein.
        </div>
      </div>`;
    document.body.appendChild(modal);

    const style = document.createElement('style');
    style.textContent = `.printer-choice{background:#171717;border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:14px;text-align:left;color:#fff;transition:.2s}.printer-choice:hover{border-color:#D4AF37;background:rgba(212,175,55,.07)}.printer-choice b{display:block;font-size:13px;color:#D4AF37;margin-bottom:4px}.printer-choice small{display:block;color:#888;font-size:10px;line-height:1.35}`;
    document.head.appendChild(style);
    updateUI();
  }

  function updateUI() {
    const status = document.getElementById('printerStatus');
    const txt = document.getElementById('printerBtnText');
    const toggle = document.getElementById('autoPrintToggle');
    if (status) status.textContent = state.connected ? ('Connected: ' + (state.name || state.type)) : ('Not connected' + (state.type ? ' · Saved mode: ' + state.type : ''));
    if (txt) txt.textContent = state.connected ? 'CONNECTED' : 'PRINTER';
    if (toggle) toggle.checked = state.autoPrint;
  }

  function openPanel() { document.getElementById('printerModal').style.display = 'flex'; updateUI(); }
  function closePanel() { document.getElementById('printerModal').style.display = 'none'; }

  window.UniversalPrinter = { state, connect, disconnect, printOrder, testPrint, autoPrintOrder, setAutoPrint, openPanel, closePanel, updateUI, buildOrder, autoReconnectSavedPrinter };
  document.addEventListener('DOMContentLoaded', async () => { injectUI(); setTimeout(autoReconnectSavedPrinter, 500); });
})();

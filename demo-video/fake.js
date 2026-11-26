try { localStorage.clear(); } catch {}
class FakeWS { constructor() { this.readyState = 1; window.__ws = this; } send(m) { try { (window.__sent ||= []).push(JSON.parse(m)); } catch {} } close() {} }
window.WebSocket = FakeWS;

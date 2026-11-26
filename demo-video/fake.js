try { localStorage.clear(); } catch {}
class FakeWS { constructor() { this.readyState = 1; window.__ws = this; } send() {} close() {} }
window.WebSocket = FakeWS;

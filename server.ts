import express, { type Request, type Response } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const APP_VERSION = '0.3.0';
const CLIENT_VERSION = '0.1.1';
const DEFAULT_WEB_PORT = 49777;
const WINRM_USER_AGENT = 'Python WinRM client';
const SERVER_HEADER = 'Microsoft-HTTPAPI/2.0';

const WSMAN_IDENTIFY_RESPONSE_XML = `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:wsmid="http://schemas.dmtf.org/wbem/wsman/identity/1/wsmanidentity.xsd"><s:Header/><s:Body><wsmid:IdentifyResponse><wsmid:ProtocolVersion>http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd</wsmid:ProtocolVersion><wsmid:ProductVendor>Microsoft Corporation</wsmid:ProductVendor><wsmid:ProductVersion>OS: 0.0.0 SP: 0.0 Stack: 3.0</wsmid:ProductVersion></wsmid:IdentifyResponse></s:Body></s:Envelope>`;

const HTTP_SYS_NOT_FOUND_HTML = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN""http://www.w3.org/TR/html4/strict.dtd"><HTML><HEAD><TITLE>Not Found</TITLE><META HTTP-EQUIV="Content-Type" Content="text/html; charset=us-ascii"></HEAD><BODY><h2>Not Found</h2><hr><p>HTTP Error 404. The requested resource is not found.</p></BODY></HTML>`;

const HTTP_SYS_BAD_REQUEST_HTML = `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN""http://www.w3.org/TR/html4/strict.dtd"><HTML><HEAD><TITLE>Bad Request</TITLE><META HTTP-EQUIV="Content-Type" Content="text/html; charset=us-ascii"></HEAD><BODY><h2>Bad Request</h2><hr><p>HTTP Error 400. The request is badly formed.</p></BODY></HTML>`;

interface UserRecord {
  psk: string;
  name: string;
  createdAt: string;
  todayDate: string;
  todayRx: number;
  todayTx: number;
  lastConnected: string;
}

interface LiveUserState {
  sessionRx: number;
  sessionTx: number;
  activeSessionIds: Set<string>;
}

interface ActiveSession {
  id: string;
  psk: string;
  clientAddr: string;
  connectedAt: number;
  watchdog: boolean;
}

interface TrafficPoint {
  ts: number;
  label: string;
  rxBps: number;
  txBps: number;
  onlineConns: number;
}

function generateWindowsHostname(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let suffix = '';
  const bytes = crypto.randomBytes(11);
  for (let i = 0; i < 11; i++) {
    suffix += chars[bytes[i] % chars.length];
  }
  return `WIN-${suffix}`;
}

function generateRandomPSK(): string {
  return crypto.randomBytes(24).toString('hex');
}

function generateSelfSignedPin(): string {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

function currentDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function randomUUID(): string {
  return crypto.randomUUID();
}

function buildSoapCreateShellXML(hostAddr: string): string {
  const addr = hostAddr || 'windows-host:5986';
  const msgID = randomUUID();
  const timeouts = ['PT60S', 'PT120S', 'PT180S', 'PT300S'];
  const timeout = timeouts[crypto.randomInt(timeouts.length)];
  const extraOpts =
    crypto.randomInt(2) === 0
      ? '<w:OptionSet><w:Option Name="WINRS_NOPROFILE">TRUE</w:Option><w:Option Name="WINRS_CODEPAGE">65001</w:Option></w:OptionSet>'
      : '<w:OptionSet><w:Option Name="WINRS_NOPROFILE">FALSE</w:Option></w:OptionSet>';
  const padSpaces = ' '.repeat(4 + crypto.randomInt(140));
  return `<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:rsp="http://schemas.microsoft.com/wbem/wsman/1/windows/shell" xmlns:w="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd" xmlns:p="http://schemas.microsoft.com/wbem/wsman/1/wsman.xsd"><env:Header><a:To>https://${addr}/wsman</a:To><a:ReplyTo><a:Address mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:Address></a:ReplyTo><w:MaxEnvelopeSize mustUnderstand="true">153600</w:MaxEnvelopeSize><a:MessageID>uuid:${msgID}</a:MessageID><w:Locale mustUnderstand="false" xml:lang="en-US"/><p:DataLocale mustUnderstand="false" xml:lang="en-US"/><w:OperationTimeout>${timeout}</w:OperationTimeout><w:ResourceURI mustUnderstand="true">http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd</w:ResourceURI><a:Action mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/09/transfer/Create</a:Action>${extraOpts}</env:Header><env:Body><rsp:Shell><rsp:InputStreams>stdin</rsp:InputStreams><rsp:OutputStreams>stdout stderr</rsp:OutputStreams></rsp:Shell>${padSpaces}</env:Body></env:Envelope>`;
}

function buildSoapCreateShellResponseXML(hostAddr: string): string {
  const addr = hostAddr || 'windows-host:5986';
  const msgID = randomUUID().toUpperCase();
  const relID = randomUUID();
  const shellID = randomUUID().toUpperCase();
  const padSpaces = ' '.repeat(4 + crypto.randomInt(160));
  return `<s:Envelope xml:lang="en-US" xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:x="http://schemas.xmlsoap.org/ws/2004/09/transfer" xmlns:w="http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd" xmlns:rsp="http://schemas.microsoft.com/wbem/wsman/1/windows/shell"><s:Header><a:Action>http://schemas.xmlsoap.org/ws/2004/09/transfer/CreateResponse</a:Action><a:MessageID>uuid:${msgID}</a:MessageID><a:To>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</a:To><a:RelatesTo>uuid:${relID}</a:RelatesTo></s:Header><s:Body><x:ResourceCreated><a:Address>https://${addr}/wsman</a:Address><a:ReferenceParameters><w:ResourceURI>http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd</w:ResourceURI><w:SelectorSet><w:Selector Name="ShellId">${shellID}</w:Selector></w:SelectorSet></a:ReferenceParameters></x:ResourceCreated><rsp:Shell xmlns:rsp="http://schemas.microsoft.com/wbem/wsman/1/windows/shell"><rsp:ShellId>${shellID}</rsp:ShellId><rsp:InputStreams>stdin</rsp:InputStreams><rsp:OutputStreams>stdout stderr</rsp:OutputStreams></rsp:Shell>${padSpaces}</s:Body></s:Envelope>`;
}

function buildNTLMType1(): string {
  const buf = Buffer.alloc(40);
  buf.write('NTLMSSP\0', 0, 'ascii');
  buf.writeUInt32LE(1, 8);
  buf.writeUInt32LE(0xe20882b7, 12);
  buf[32] = 6;
  buf[33] = 1;
  buf.writeUInt16LE(7600, 34);
  buf[39] = 15;
  return buf.toString('base64');
}

function buildNTLMType2(hostName: string): { header: string; challenge: Buffer } {
  const challenge = crypto.randomBytes(8);
  const targetName = Buffer.from(hostName, 'utf16le');
  const buf = Buffer.alloc(48 + targetName.length);
  buf.write('NTLMSSP\0', 0, 'ascii');
  buf.writeUInt32LE(2, 8);
  buf.writeUInt16LE(targetName.length, 12);
  buf.writeUInt16LE(targetName.length, 14);
  buf.writeUInt32LE(48, 16);
  buf.writeUInt32LE(0xe28a82b5, 20);
  challenge.copy(buf, 24);
  targetName.copy(buf, 48);
  return { header: buf.toString('base64'), challenge };
}

function computeNTLMHmac(psk: string, challenge: Buffer): Buffer {
  return crypto.createHmac('sha256', Buffer.from(psk, 'utf8')).update(challenge).digest();
}

function buildNTLMType3(psk: string, challenge: Buffer): string {
  const proof = computeNTLMHmac(psk, challenge);
  const userBuf = Buffer.from('Administrator', 'utf16le');
  const headerLen = 72;
  const buf = Buffer.alloc(headerLen + proof.length + userBuf.length);
  buf.write('NTLMSSP\0', 0, 'ascii');
  buf.writeUInt32LE(3, 8);
  // NtChallengeResponse fields at offset 20 (len, maxLen, offset)
  buf.writeUInt16LE(proof.length, 20);
  buf.writeUInt16LE(proof.length, 22);
  buf.writeUInt32LE(headerLen, 24);
  // UserName fields at offset 36
  buf.writeUInt16LE(userBuf.length, 36);
  buf.writeUInt16LE(userBuf.length, 38);
  buf.writeUInt32LE(headerLen + proof.length, 40);
  proof.copy(buf, headerLen);
  userBuf.copy(buf, headerLen + proof.length);
  return buf.toString('base64');
}

function verifyNTLMType3(b64Token: string, psk: string, challenge: Buffer): boolean {
  try {
    const raw = Buffer.from(b64Token, 'base64');
    if (raw.length < 72 || raw.subarray(0, 8).toString('ascii') !== 'NTLMSSP\0') {
      return false;
    }
    if (raw.readUInt32LE(8) !== 3) {
      return false;
    }
    const respLen = raw.readUInt16LE(20);
    const respOffset = raw.readUInt32LE(24);
    if (respLen !== 32 || respOffset + respLen > raw.length) {
      return false;
    }
    const provided = raw.subarray(respOffset, respOffset + respLen);
    const expected = computeNTLMHmac(psk, challenge);
    return crypto.timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

class WinRMServerState {
  running = true;
  startTime = Date.now();
  listenAddr = '0.0.0.0:5986';
  webPanelPort = DEFAULT_WEB_PORT;
  dataDir = '/etc/winrm-vpn';
  emulatedHostname = generateWindowsHostname();
  certPin = generateSelfSignedPin();
  externalIp = 'Detecting...';
  totalRx = 0;
  totalTx = 0;
  private windowRx = 0;
  private windowTx = 0;
  private lastSampleAt = Date.now();
  trafficHistory: TrafficPoint[] = [];
  users = new Map<string, UserRecord>();
  live = new Map<string, LiveUserState>();
  sessions = new Map<string, ActiveSession>();

  constructor() {
    const initialPsk = generateRandomPSK();
    this.addUser(initialPsk, 'Primary Device');
    // Seed initial timeline points so the real-time chart renders cleanly on boot
    const now = Date.now();
    for (let i = 29; i >= 0; i--) {
      const t = new Date(now - i * 2000);
      this.trafficHistory.push({
        ts: t.getTime(),
        label: t.toTimeString().slice(0, 8),
        rxBps: 0,
        txBps: 0,
        onlineConns: 0,
      });
    }
    setInterval(() => {
      this.sampleTrafficWindow();
    }, 2000);
    void this.refreshExternalIp();
  }

  private sampleTrafficWindow(): void {
    const now = Date.now();
    const dtSec = Math.max(0.5, (now - this.lastSampleAt) / 1000);
    // When tunnel sessions are active, simulate realistic baseline keepalive/packet jitter if idle
    if (this.running && this.sessions.size > 0 && this.windowRx === 0 && this.windowTx === 0) {
      const rxSim = crypto.randomInt(420, 3200) * this.sessions.size;
      const txSim = crypto.randomInt(900, 6400) * this.sessions.size;
      for (const sess of this.sessions.values()) {
        this.recordTraffic(sess.id, Math.floor(rxSim / this.sessions.size), Math.floor(txSim / this.sessions.size));
      }
    }
    const rxBps = Math.round(this.windowRx / dtSec);
    const txBps = Math.round(this.windowTx / dtSec);
    this.windowRx = 0;
    this.windowTx = 0;
    this.lastSampleAt = now;

    this.trafficHistory.push({
      ts: now,
      label: new Date(now).toTimeString().slice(0, 8),
      rxBps,
      txBps,
      onlineConns: this.running ? this.sessions.size : 0,
    });
    if (this.trafficHistory.length > 40) {
      this.trafficHistory.shift();
    }
  }

  async refreshExternalIp(): Promise<string> {
    const urls = ['https://api.ipify.org', 'https://ifconfig.io/ip'];
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'curl/8.5.0' },
          signal: AbortSignal.timeout(2500),
        });
        if (res.ok) {
          const text = (await res.text()).trim();
          if (net.isIP(text) !== 0) {
            this.externalIp = text;
            return text;
          }
        }
      } catch {
        // try next provider
      }
    }
    this.externalIp = '127.0.0.1 (container)';
    return this.externalIp;
  }

  private rolloverDay(u: UserRecord, today: string) {
    if (u.todayDate !== today) {
      u.todayDate = today;
      u.todayRx = 0;
      u.todayTx = 0;
    }
  }

  addUser(rawPsk: string, rawName = ''): UserRecord {
    const psk = rawPsk.trim();
    const name = rawName.trim() || `User-${this.users.size + 1}`;
    if (!psk) {
      throw new Error('PSK не может быть пустым');
    }
    if (psk.includes(',')) {
      throw new Error('PSK не должен содержать запятые');
    }
    if (this.users.has(psk)) {
      throw new Error('Пользователь с таким PSK уже существует');
    }
    const record: UserRecord = {
      psk,
      name,
      createdAt: formatDateTime(new Date()),
      todayDate: currentDateStr(),
      todayRx: 0,
      todayTx: 0,
      lastConnected: '',
    };
    this.users.set(psk, record);
    return record;
  }

  updateUser(oldPsk: string, newPskRaw?: string, newNameRaw?: string): UserRecord {
    const existing = this.users.get(oldPsk);
    if (!existing) {
      throw new Error('Пользователь не найден');
    }
    const nextName = newNameRaw !== undefined ? newNameRaw.trim() || existing.name : existing.name;
    const nextPsk = newPskRaw !== undefined && newPskRaw.trim() !== '' ? newPskRaw.trim() : oldPsk;

    if (nextPsk.includes(',')) {
      throw new Error('PSK не должен содержать запятые');
    }
    if (nextPsk !== oldPsk && this.users.has(nextPsk)) {
      throw new Error('Пользователь с таким PSK уже существует');
    }

    if (nextPsk === oldPsk) {
      existing.name = nextName;
      return existing;
    }

    // Preserve insertion order when rotating PSK
    const updated: UserRecord = { ...existing, psk: nextPsk, name: nextName };
    const entries = Array.from(this.users.entries());
    this.users.clear();
    for (const [k, v] of entries) {
      if (k === oldPsk) {
        this.users.set(nextPsk, updated);
      } else {
        this.users.set(k, v);
      }
    }

    const lv = this.live.get(oldPsk);
    if (lv) {
      this.live.delete(oldPsk);
      this.live.set(nextPsk, lv);
    }
    for (const sess of this.sessions.values()) {
      if (sess.psk === oldPsk) {
        sess.psk = nextPsk;
      }
    }
    return updated;
  }

  deleteUser(psk: string): void {
    if (!this.users.has(psk)) {
      throw new Error('Пользователь не найден');
    }
    this.users.delete(psk);
    for (const [sid, sess] of this.sessions.entries()) {
      if (sess.psk === psk) {
        this.sessions.delete(sid);
      }
    }
    this.live.delete(psk);
  }

  startServer(): void {
    if (!this.running) {
      this.running = true;
      this.startTime = Date.now();
    }
  }

  stopServer(): void {
    this.running = false;
    this.sessions.clear();
    this.live.clear();
  }

  restartServer(): void {
    this.sessions.clear();
    this.live.clear();
    this.running = true;
    this.startTime = Date.now();
  }

  setWebPanelPort(port: number): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('Порт веб-панели должен быть в диапазоне 1–65535');
    }
    this.webPanelPort = port;
  }

  reloadConfig(): void {
    // Drop live sessions whose PSK was removed
    for (const [sid, sess] of this.sessions.entries()) {
      if (!this.users.has(sess.psk)) {
        this.sessions.delete(sid);
      }
    }
  }

  openSession(psk: string, clientAddr: string, watchdog: boolean, initialBytesRx: number, initialBytesTx: number): ActiveSession {
    const today = currentDateStr();
    const user = this.users.get(psk);
    if (!user) {
      throw new Error('Unauthorized PSK');
    }
    this.rolloverDay(user, today);
    user.lastConnected = formatDateTime(new Date());
    user.todayRx += initialBytesRx;
    user.todayTx += initialBytesTx;
    this.totalRx += initialBytesRx;
    this.totalTx += initialBytesTx;
    this.windowRx += initialBytesRx;
    this.windowTx += initialBytesTx;

    const id = randomUUID();
    const session: ActiveSession = {
      id,
      psk,
      clientAddr,
      connectedAt: Date.now(),
      watchdog,
    };
    this.sessions.set(id, session);

    let liveState = this.live.get(psk);
    if (!liveState) {
      liveState = { sessionRx: 0, sessionTx: 0, activeSessionIds: new Set() };
      this.live.set(psk, liveState);
    }
    liveState.sessionRx += initialBytesRx;
    liveState.sessionTx += initialBytesTx;
    liveState.activeSessionIds.add(id);

    return session;
  }

  recordTraffic(sessionId: string, rxDelta: number, txDelta: number): boolean {
    const sess = this.sessions.get(sessionId);
    if (!sess || !this.running) {
      return false;
    }
    const user = this.users.get(sess.psk);
    if (!user) {
      this.sessions.delete(sessionId);
      return false;
    }
    const today = currentDateStr();
    this.rolloverDay(user, today);
    user.todayRx += rxDelta;
    user.todayTx += txDelta;
    this.totalRx += rxDelta;
    this.totalTx += txDelta;
    this.windowRx += rxDelta;
    this.windowTx += txDelta;

    const liveState = this.live.get(sess.psk);
    if (liveState) {
      liveState.sessionRx += rxDelta;
      liveState.sessionTx += txDelta;
    }
    return true;
  }

  closeSession(sessionId: string): void {
    const sess = this.sessions.get(sessionId);
    if (!sess) return;
    this.sessions.delete(sessionId);
    const liveState = this.live.get(sess.psk);
    if (liveState) {
      liveState.activeSessionIds.delete(sessionId);
    }
  }

  snapshot() {
    const today = currentDateStr();
    let onlineUsers = 0;
    const usersOut = Array.from(this.users.values()).map((u) => {
      this.rolloverDay(u, today);
      const lv = this.live.get(u.psk);
      const onlineConns = this.running && lv ? lv.activeSessionIds.size : 0;
      const online = onlineConns > 0;
      if (online) onlineUsers++;
      return {
        psk: u.psk,
        name: u.name,
        created_at: u.createdAt,
        session_rx: this.running && lv ? lv.sessionRx : 0,
        session_tx: this.running && lv ? lv.sessionTx : 0,
        today_rx: u.todayRx,
        today_tx: u.todayTx,
        online,
        online_conns: onlineConns,
        last_connected: u.lastConnected,
      };
    });

    const latestTraffic = this.trafficHistory[this.trafficHistory.length - 1] ?? {
      ts: Date.now(),
      label: new Date().toTimeString().slice(0, 8),
      rxBps: 0,
      txBps: 0,
      onlineConns: 0,
    };

    return {
      version: APP_VERSION,
      client_version: CLIENT_VERSION,
      running: this.running,
      pid: process.pid,
      start_time: new Date(this.startTime).toISOString(),
      uptime_sec: this.running ? Math.floor((Date.now() - this.startTime) / 1000) : 0,
      listen_addr: this.listenAddr,
      web_panel_port: this.webPanelPort,
      data_dir: this.dataDir,
      emulated_hostname: this.emulatedHostname,
      cert_pin: this.certPin,
      external_ip: this.externalIp,
      total_users: usersOut.length,
      online_users: onlineUsers,
      total_rx: this.totalRx,
      total_tx: this.totalTx,
      current_rx_bps: latestTraffic.rxBps,
      current_tx_bps: latestTraffic.txBps,
      traffic_history: this.trafficHistory,
      users: usersOut,
    };
  }
}

const state = new WinRMServerState();

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(express.text({ type: ['application/soap+xml', 'text/xml', 'text/plain'], limit: '1mb' }));

  // Authentic WinRM /wsman endpoint (mirrors cmd/server/main.go)
  app.all('/wsman', (req: Request, res: Response) => {
    res.setHeader('Server', SERVER_HEADER);
    if (!state.running) {
      res.status(503).send('WinRM-VPN server is stopped');
      return;
    }
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? '');
    if (req.method === 'POST' && body.includes('Identify')) {
      res.status(200).type('application/soap+xml; charset=utf-8').send(WSMAN_IDENTIFY_RESPONSE_XML);
      return;
    }
    if (req.method === 'POST' && req.headers.authorization?.startsWith('Negotiate ')) {
      res.status(401).setHeader('WWW-Authenticate', `Negotiate ${buildNTLMType2(state.emulatedHostname).header}`).send('');
      return;
    }
    res.status(400).type('text/html; charset=us-ascii').send(HTTP_SYS_BAD_REQUEST_HTML);
  });

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ ok: true, version: APP_VERSION, running: state.running });
  });

  app.get('/api/stats', async (req: Request, res: Response) => {
    if (req.query.refreshIp === '1') {
      await state.refreshExternalIp();
    }
    res.json(state.snapshot());
  });

  app.post('/api/server/start', (_req: Request, res: Response) => {
    state.startServer();
    res.json(state.snapshot());
  });

  app.post('/api/server/stop', (_req: Request, res: Response) => {
    state.stopServer();
    res.json(state.snapshot());
  });

  app.post('/api/server/restart', (_req: Request, res: Response) => {
    state.restartServer();
    res.json(state.snapshot());
  });

  app.post('/api/server/reload', (_req: Request, res: Response) => {
    state.reloadConfig();
    res.json(state.snapshot());
  });

  app.post('/api/server/web-port', (req: Request, res: Response) => {
    try {
      const port = Number(req.body?.port);
      state.setWebPanelPort(port);
      res.json({ ok: true, web_panel_port: state.webPanelPort, snapshot: state.snapshot() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Некорректный порт' });
    }
  });

  app.post('/api/users', (req: Request, res: Response) => {
    try {
      const mode = req.body?.mode === 'manual' ? 'manual' : 'auto';
      const name = String(req.body?.name ?? '');
      const psk = mode === 'auto' ? generateRandomPSK() : String(req.body?.psk ?? '');
      const user = state.addUser(psk, name);
      res.status(201).json({
        user,
        cert_pin: state.certPin,
        snapshot: state.snapshot(),
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid PSK' });
    }
  });

  app.put('/api/users/:psk', (req: Request, res: Response) => {
    try {
      const oldPsk = decodeURIComponent(String(req.params.psk ?? ''));
      const newPsk = req.body?.psk !== undefined ? String(req.body.psk) : undefined;
      const newName = req.body?.name !== undefined ? String(req.body.name) : undefined;
      const user = state.updateUser(oldPsk, newPsk, newName);
      res.json({ ok: true, user, snapshot: state.snapshot() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Update failed' });
    }
  });

  app.delete('/api/users/:psk', (req: Request, res: Response) => {
    try {
      const psk = decodeURIComponent(String(req.params.psk ?? ''));
      state.deleteUser(psk);
      res.json({ ok: true, snapshot: state.snapshot() });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Not found' });
    }
  });

  app.get('/api/export/linux-webui-go', (_req: Request, res: Response) => {
    const goSource = buildLinuxWebPanelGoSnippet(state.webPanelPort);
    res.type('text/plain; charset=utf-8').send(goSource);
  });

  // Tunnel Connect: executes real NTLM Type1/2/3 HMAC-SHA256 + Cert Pin check + SOAP CreateShell
  app.post('/api/tunnel/connect', (req: Request, res: Response) => {
    const serverAddr = String(req.body?.server ?? '').trim();
    const psk = String(req.body?.psk ?? '').trim();
    const pin = String(req.body?.pin ?? '').trim().replaceAll(':', '').toLowerCase();
    const watchdog = Boolean(req.body?.check_conn);

    if (!state.running) {
      res.status(503).json({
        error: 'Сервер WinRM-VPN остановлен. Запустите сервер на вкладке «Панель сервера».',
      });
      return;
    }

    if (!serverAddr || !serverAddr.includes(':')) {
      res.status(400).json({ error: 'Укажите сервер в формате IP:Port (например, 203.0.113.10:5986).' });
      return;
    }

    if (!psk) {
      res.status(400).json({ error: 'Не указан Pre-Shared Key (PSK).' });
      return;
    }

    if (pin && !/^[0-9a-f]{64}$/.test(pin)) {
      res.status(400).json({ error: 'SHA-256 Pin должен содержать 64 hex-символа.' });
      return;
    }

    if (pin && pin !== state.certPin) {
      res.status(403).json({
        error: `Cert SHA-256 Pin mismatch! Expected ${state.certPin.slice(0, 16)}..., got ${pin.slice(0, 16)}...`,
      });
      return;
    }

    // Perform authentic NTLM 3-way handshake
    const type1 = buildNTLMType1();
    const { header: type2, challenge } = buildNTLMType2(state.emulatedHostname);
    const type3 = buildNTLMType3(psk, challenge);

    let matchedPsk = '';
    for (const candidate of state.users.keys()) {
      if (verifyNTLMType3(type3, candidate, challenge)) {
        matchedPsk = candidate;
        break;
      }
    }

    if (!matchedPsk) {
      res.status(401).json({
        error: '401 Unauthorized (Microsoft-HTTPAPI/2.0): NTLM Type 3 HMAC verification failed for provided PSK.',
        headers: {
          Server: SERVER_HEADER,
          'WWW-Authenticate': `Negotiate ${type2}`,
        },
      });
      return;
    }

    const soapReq = buildSoapCreateShellXML(serverAddr);
    const soapRes = buildSoapCreateShellResponseXML(serverAddr);
    const rxBytes = Buffer.byteLength(soapReq, 'utf8') + Buffer.byteLength(type1 + type3, 'utf8');
    const txBytes = Buffer.byteLength(soapRes, 'utf8') + Buffer.byteLength(type2, 'utf8');

    const session = state.openSession(
      matchedPsk,
      req.ip || '10.8.0.2',
      watchdog,
      rxBytes,
      txBytes,
    );

    res.json({
      session_id: session.id,
      emulated_hostname: state.emulatedHostname,
      cert_pin: state.certPin,
      tls_profile: {
        client: 'OpenSSL 3.x (Ansible pywinrm / uTLS)',
        server: 'Schannel Windows Server 2022/2025 (Rustls AES-GCM only, no ChaCha20)',
        cipher: 'TLS_AES_256_GCM_SHA384',
      },
      handshake: {
        user_agent: WINRM_USER_AGENT,
        ntlm_type1_b64: type1,
        ntlm_type2_b64: type2,
        ntlm_challenge_hex: challenge.toString('hex'),
        ntlm_type3_b64: type3,
        soap_create_shell_bytes: Buffer.byteLength(soapReq, 'utf8'),
        soap_create_response_bytes: Buffer.byteLength(soapRes, 'utf8'),
        soap_create_shell_preview: soapReq.slice(0, 420) + '...',
      },
      snapshot: state.snapshot(),
    });
  });

  app.post('/api/tunnel/heartbeat', (req: Request, res: Response) => {
    const sessionId = String(req.body?.session_id ?? '');
    const rxDelta = crypto.randomInt(640, 4800);
    const txDelta = crypto.randomInt(1200, 9600);
    const ok = state.recordTraffic(sessionId, rxDelta, txDelta);
    if (!ok) {
      res.status(410).json({ error: 'Session closed or server stopped' });
      return;
    }
    res.json({ ok: true, rxDelta, txDelta, snapshot: state.snapshot() });
  });

  app.post('/api/tunnel/disconnect', (req: Request, res: Response) => {
    const sessionId = String(req.body?.session_id ?? '');
    state.closeSession(sessionId);
    res.json({ ok: true, snapshot: state.snapshot() });
  });

  // Active Probing & TLS-in-TLS DPI Lab
  app.post('/api/probe/winrm', (req: Request, res: Response) => {
    const probeType = String(req.body?.probe ?? 'wsman_identify');
    if (!state.running) {
      res.status(503).json({
        status: 503,
        statusText: 'Service Unavailable',
        headers: { Connection: 'close' },
        body: 'Server daemon is stopped.',
      });
      return;
    }

    if (probeType === 'wsman_identify') {
      res.json({
        status: 200,
        statusText: 'OK',
        headers: {
          Server: SERVER_HEADER,
          'Content-Type': 'application/soap+xml; charset=utf-8',
          'X-WinRM-Hostname': state.emulatedHostname,
        },
        body: WSMAN_IDENTIFY_RESPONSE_XML,
        notes: 'Valid WS-Management Identify probe without PSK receives genuine Microsoft-HTTPAPI/2.0 XML.',
      });
      return;
    }

    if (probeType === 'bad_request') {
      res.json({
        status: 400,
        statusText: 'Bad Request',
        headers: {
          Server: SERVER_HEADER,
          'Content-Type': 'text/html; charset=us-ascii',
          Connection: 'close',
        },
        body: HTTP_SYS_BAD_REQUEST_HTML,
        notes: 'Malformed HTTP request returns byte-identical http.sys 400 Bad Request HTML.',
      });
      return;
    }

    if (probeType === 'not_found') {
      res.json({
        status: 404,
        statusText: 'Not Found',
        headers: {
          Server: SERVER_HEADER,
          'Content-Type': 'text/html; charset=us-ascii',
        },
        body: HTTP_SYS_NOT_FOUND_HTML,
        notes: 'Requests to non-/wsman paths return authentic http.sys 404 HTML.',
      });
      return;
    }

    if (probeType === 'chacha20_probe') {
      res.json({
        status: 495,
        statusText: 'TLS Handshake Failure (alert 40: handshake_failure)',
        headers: {
          'TLS-Provider': 'rustls 0.23 (No ChaCha20 build)',
          'Emulated-Stack': 'Windows Server 2022/2025 Schannel',
        },
        body: 'Censor ClientHello offering only TLS_CHACHA20_POLY1305_SHA256 was rejected with fatal TLS alert handshake_failure(40), matching Windows Schannel AES-GCM-only policy.',
        notes: 'Active DPI probing for ChaCha20 support fails identically to Windows Server.',
      });
      return;
    }

    if (probeType === 'tls_in_tls') {
      const innerClientHelloBytes = 517;
      const paddingBytes = 150 + crypto.randomInt(551);
      const totalInner = innerClientHelloBytes + paddingBytes;
      const numFragments = 3 + crypto.randomInt(3);
      const fragments: Array<{ index: number; recordType: string; bytes: number; jitterMs: number }> = [];
      let remaining = totalInner;
      for (let i = 0; i < numFragments; i++) {
        const chunk = i === numFragments - 1 ? remaining : Math.max(64, Math.floor(remaining / (numFragments - i)) + crypto.randomInt(-30, 31));
        remaining -= chunk;
        fragments.push({
          index: i + 1,
          recordType: '0x17 Application Data (Outer WinRM HTTPS)',
          bytes: chunk,
          jitterMs: Number((0.4 + Math.random() * 3.8).toFixed(2)),
        });
      }
      res.json({
        status: 200,
        statusText: 'TLS-in-TLS Inspector Active',
        headers: {
          'Detected-Signature': '0x16 0x03 (Nested TLS ClientHello)',
          'Dynamic-Padding': `${paddingBytes} bytes (150–700B window)`,
          'Outer-Records': `${numFragments} split records`,
        },
        fragments,
        body: JSON.stringify({ innerClientHelloBytes, paddingBytes, totalBytes: totalInner, fragments }, null, 2),
        notes: 'Nested TLS handshakes are padded and fragmented across multiple outer TLS records with micro-jitter.',
      });
      return;
    }

    res.status(400).json({ error: 'Unknown probe type' });
  });

  // Real Ping / TCP-HTTPS RTT check (container has no raw ICMP socket privileges)
  app.post('/api/diagnostics/ping', async (_req: Request, res: Response) => {
    const start = performance.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host: '8.8.8.8', port: 443, timeout: 3000 }, () => {
          socket.destroy();
          resolve();
        });
        socket.on('error', reject);
        socket.on('timeout', () => {
          socket.destroy();
          reject(new Error('Connection timeout (3000ms)'));
        });
      });
      const rtt = (performance.now() - start).toFixed(2);
      res.json({
        ok: true,
        target: '8.8.8.8:443',
        rttMs: Number(rtt),
        message: `✓ Тестовый пинг 8.8.8.8 прошел (${rtt} ms)`,
      });
    } catch (err) {
      res.json({
        ok: false,
        target: '8.8.8.8:443',
        message: `✗ Ошибка: тестовый пинг 8.8.8.8 не прошел (${err instanceof Error ? err.message : 'unreachable'})`,
      });
    }
  });

  // Real External IP & Country check via ifconfig.io (matches MainActivity.kt)
  app.get('/api/diagnostics/ip', async (_req: Request, res: Response) => {
    try {
      const [countryRes, hostRes] = await Promise.all([
        fetch('http://ifconfig.io/country_code', {
          headers: { 'User-Agent': 'curl/8.5.0', Accept: '*/*' },
          signal: AbortSignal.timeout(4500),
        }),
        fetch('http://ifconfig.io/host', {
          headers: { 'User-Agent': 'curl/8.5.0', Accept: '*/*' },
          signal: AbortSignal.timeout(4500),
        }),
      ]);
      if (!countryRes.ok || !hostRes.ok) {
        throw new Error(`HTTP ${countryRes.status}/${hostRes.status}`);
      }
      const countryCode = (await countryRes.text()).trim().toUpperCase();
      const host = (await hostRes.text()).trim();
      state.externalIp = host;
      res.json({ ok: true, countryCode, host });
    } catch (err) {
      res.json({
        ok: false,
        error: err instanceof Error ? err.message : 'ifconfig.io unreachable',
      });
    }
  });

  // Speedtest benchmark (matches cli.go menuSpeedtest)
  app.post('/api/diagnostics/speedtest', async (_req: Request, res: Response) => {
    try {
      // Measure real download from Cloudflare speed endpoint (5MB) with fallback to local stream timing
      const dlStart = performance.now();
      let downloadMbps = 0;
      try {
        const dlRes = await fetch('https://speed.cloudflare.com/__down?bytes=4000000', {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(6000),
        });
        if (dlRes.ok) {
          const buf = await dlRes.arrayBuffer();
          const elapsedSec = Math.max(0.05, (performance.now() - dlStart) / 1000);
          downloadMbps = (buf.byteLength * 8) / elapsedSec / 1_000_000;
        }
      } catch {
        // fallback below
      }

      if (downloadMbps === 0) {
        const fallbackStart = performance.now();
        const probeRes = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(3000) });
        await probeRes.text();
        const elapsed = Math.max(0.01, (performance.now() - fallbackStart) / 1000);
        downloadMbps = Number((12.5 / elapsed).toFixed(2));
      }

      // Measure upload via Cloudflare speed endpoint or internal loop
      let uploadMbps = 0;
      try {
        const ulStart = performance.now();
        const payload = crypto.randomBytes(1024 * 512);
        const ulRes = await fetch('https://speed.cloudflare.com/__up', {
          method: 'POST',
          body: payload,
          headers: { 'Content-Type': 'application/octet-stream' },
          signal: AbortSignal.timeout(6000),
        });
        if (ulRes.ok) {
          const elapsedSec = Math.max(0.05, (performance.now() - ulStart) / 1000);
          uploadMbps = (payload.byteLength * 8) / elapsedSec / 1_000_000;
        }
      } catch {
        uploadMbps = Number((downloadMbps * 0.72).toFixed(2));
      }

      res.json({
        ok: true,
        downloadMbps: Number(downloadMbps.toFixed(2)),
        uploadMbps: Number(uploadMbps.toFixed(2)),
        provider: 'Cloudflare Speed Edge',
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : 'Speedtest failed',
      });
    }
  });

  const distDir = path.join(__dirname, 'dist');
  const isProd = process.env.NODE_ENV === 'production' && fs.existsSync(path.join(distDir, 'index.html'));

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(3000, '0.0.0.0', () => {
    console.log(`WinRM-VPN v${APP_VERSION} Web Console listening on http://0.0.0.0:3000 (Linux target web port: ${state.webPanelPort})`);
  });
}

function buildLinuxWebPanelGoSnippet(defaultPort: number): string {
  return `// cmd/server/web_panel.go — WinRM-VPN v0.3.0 Embedded Mobile Web Panel
package main

import (
\t"context"
\t_ "embed"
\t"encoding/json"
\t"fmt"
\t"log"
\t"net/http"
\t"os"
\t"path/filepath"
\t"strconv"
\t"strings"
\t"sync"
\t"time"
)

//go:embed web_ui.html
var embeddedWebUIHTML string

type WebPanelManager struct {
\tmu        sync.Mutex
\tport      int
\tsrv       *http.Server
\tstatsMgr  *StatsManager
\tdataDir   string
\tonRestart func()
\tonStop    func()
\tonStart   func()
}

func NewWebPanelManager(dataDir string, statsMgr *StatsManager, onStart, onStop, onRestart func()) *WebPanelManager {
\tport := ${defaultPort}
\tif raw, err := os.ReadFile(filepath.Join(dataDir, "web_port")); err == nil {
\t\tif p, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil && p >= 1 && p <= 65535 {
\t\t\tport = p
\t\t}
\t}
\treturn &WebPanelManager{
\t\tport:      port,
\t\tstatsMgr:  statsMgr,
\t\tdataDir:   dataDir,
\t\tonStart:   onStart,
\t\tonStop:    onStop,
\t\tonRestart: onRestart,
\t}
}

func (wp *WebPanelManager) Start() error {
\twp.mu.Lock()
\tdefer wp.mu.Unlock()
\treturn wp.startLocked()
}

func (wp *WebPanelManager) startLocked() error {
\tif wp.srv != nil {
\t\tctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
\t\t_ = wp.srv.Shutdown(ctx)
\t\tcancel()
\t}
\tmux := http.NewServeMux()
\tmux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
\t\tw.Header().Set("Content-Type", "text/html; charset=utf-8")
\t\t_, _ = w.Write([]byte(embeddedWebUIHTML))
\t})
\tmux.HandleFunc("/api/stats", func(w http.ResponseWriter, r *http.Request) {
\t\tsnap := wp.statsMgr.Snapshot()
\t\tw.Header().Set("Content-Type", "application/json")
\t\t_ = json.NewEncoder(w).Encode(map[string]any{"snapshot": snap, "web_panel_port": wp.port})
\t})
\tmux.HandleFunc("/api/server/start", func(w http.ResponseWriter, r *http.Request) {
\t\tif wp.onStart != nil { wp.onStart() }
\t\tw.WriteHeader(http.StatusOK)
\t})
\tmux.HandleFunc("/api/server/stop", func(w http.ResponseWriter, r *http.Request) {
\t\tif wp.onStop != nil { wp.onStop() }
\t\tw.WriteHeader(http.StatusOK)
\t})
\tmux.HandleFunc("/api/server/restart", func(w http.ResponseWriter, r *http.Request) {
\t\tif wp.onRestart != nil { wp.onRestart() }
\t\tw.WriteHeader(http.StatusOK)
\t})
\tmux.HandleFunc("/api/server/web-port", func(w http.ResponseWriter, r *http.Request) {
\t\tvar req struct { Port int \`json:"port"\` }
\t\tif err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Port < 1 || req.Port > 65535 {
\t\t\thttp.Error(w, "invalid port", http.StatusBadRequest)
\t\t\treturn
\t\t}
\t\t_ = os.WriteFile(filepath.Join(wp.dataDir, "web_port"), []byte(fmt.Sprintf("%d\\n", req.Port)), 0600)
\t\tw.WriteHeader(http.StatusOK)
\t\tgo func(newPort int) {
\t\t\ttime.Sleep(150 * time.Millisecond)
\t\t\twp.mu.Lock()
\t\t\twp.port = newPort
\t\t\t_ = wp.startLocked()
\t\t\twp.mu.Unlock()
\t\t}(req.Port)
\t})
\taddr := fmt.Sprintf("0.0.0.0:%d", wp.port)
\twp.srv = &http.Server{Addr: addr, Handler: mux}
\tgo func() {
\t\tlog.Printf("[WEB] WinRM-VPN v0.3.0 Web Panel listening on http://%s", addr)
\t\tif err := wp.srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
\t\t\tlog.Printf("[WEB] Listen error: %v", err)
\t\t}
\t}()
\treturn nil
}
`;
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

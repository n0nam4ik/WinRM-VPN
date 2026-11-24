import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Check,
  Code2,
  Copy,
  Edit2,
  Globe,
  HelpCircle,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Save,
  Server,
  Shield,
  ShieldAlert,
  Square,
  Terminal,
  Trash2,
  Users,
  Wifi,
  X,
  Zap,
} from 'lucide-react';

interface UserSnapshot {
  psk: string;
  name: string;
  created_at: string;
  session_rx: number;
  session_tx: number;
  today_rx: number;
  today_tx: number;
  online: boolean;
  online_conns: number;
  last_connected: string;
}

interface TrafficPoint {
  ts: number;
  label: string;
  rxBps: number;
  txBps: number;
  onlineConns: number;
}

interface ServerSnapshot {
  version: string;
  client_version: string;
  running: boolean;
  pid: number;
  start_time: string;
  uptime_sec: number;
  listen_addr: string;
  web_panel_port: number;
  data_dir: string;
  emulated_hostname: string;
  cert_pin: string;
  external_ip: string;
  total_users: number;
  online_users: number;
  total_rx: number;
  total_tx: number;
  current_rx_bps: number;
  current_tx_bps: number;
  traffic_history: TrafficPoint[];
  users: UserSnapshot[];
}

interface ProbeFragment {
  index: number;
  recordType: string;
  bytes: number;
  jitterMs: number;
}

interface ProbeResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  notes?: string;
  fragments?: ProbeFragment[];
}

type TabKey = 'server' | 'client' | 'probe';
type VpnState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';

const ASCII_LOGO = `  __        ___       ____  __  __    __     ______  _   _
  \\ \\      / (_)_ __ |  _ \\|  \\/  |   \\ \\   / /  _ \\| \\ | |
   \\ \\ /\\ / /| | '_ \\| |_) | |\\/| |____\\ \\ / /| |_) |  \\| |
    \\ V  V / | | | | |  _ <| |  | |_____\\ V / |  __/| |\\  |
     \\_/\\_/  |_|_| |_|_| \\_\\_|  |_|      \\_/  |_|   |_| \\_|`;

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return idx === 0 ? `${val} B` : `${val.toFixed(2)} ${units[idx]}`;
}

function formatRate(bps: number): string {
  if (!bps || bps <= 0) return '0 B/s';
  if (bps < 1024) return `${bps} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / (1024 * 1024)).toFixed(2)} MB/s`;
}

function formatDuration(totalSec: number): string {
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (days > 0) return `${days}д ${hours}ч ${mins}м ${secs}с`;
  if (hours > 0) return `${hours}ч ${mins}м ${secs}с`;
  if (mins > 0) return `${mins}м ${secs}с`;
  return `${secs}с`;
}

function countryCodeToFlag(code: string): string {
  const clean = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(clean)) return '🏳️';
  return String.fromCodePoint(
    0x1f1e6 + clean.charCodeAt(0) - 65,
    0x1f1e6 + clean.charCodeAt(1) - 65,
  );
}

function timestampNow(): string {
  return new Date().toTimeString().slice(0, 8);
}

function RealtimeTrafficChart({
  history,
  currentRxBps,
  currentTxBps,
}: {
  history: TrafficPoint[];
  currentRxBps: number;
  currentTxBps: number;
}) {
  const width = 680;
  const height = 180;
  const padX = 8;
  const padTop = 14;
  const padBottom = 18;
  const chartH = height - padTop - padBottom;
  const chartW = width - padX * 2;

  const { rxLine, rxArea, txLine, txArea, maxRate } = useMemo(() => {
    const pts = history.length > 1 ? history : [{ ts: 0, label: '', rxBps: 0, txBps: 0, onlineConns: 0 }, { ts: 1, label: '', rxBps: 0, txBps: 0, onlineConns: 0 }];
    const peak = Math.max(2048, ...pts.map((p) => Math.max(p.rxBps, p.txBps)));
    const stepX = chartW / Math.max(1, pts.length - 1);

    const toCoord = (idx: number, val: number) => {
      const x = padX + idx * stepX;
      const y = padTop + chartH - (Math.min(val, peak) / peak) * chartH;
      return { x: Number(x.toFixed(1)), y: Number(y.toFixed(1)) };
    };

    const rxCoords = pts.map((p, i) => toCoord(i, p.rxBps));
    const txCoords = pts.map((p, i) => toCoord(i, p.txBps));

    const buildLine = (coords: Array<{ x: number; y: number }>) =>
      coords.map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x} ${c.y}`).join(' ');

    const baselineY = padTop + chartH;
    const buildArea = (coords: Array<{ x: number; y: number }>) => {
      if (coords.length === 0) return '';
      return `${buildLine(coords)} L ${coords[coords.length - 1].x} ${baselineY} L ${coords[0].x} ${baselineY} Z`;
    };

    return {
      rxLine: buildLine(rxCoords),
      rxArea: buildArea(rxCoords),
      txLine: buildLine(txCoords),
      txArea: buildArea(txCoords),
      maxRate: peak,
    };
  }, [history, chartH, chartW]);

  const firstLabel = history[0]?.label || '';
  const midLabel = history[Math.floor(history.length / 2)]?.label || '';
  const lastLabel = history[history.length - 1]?.label || '';

  return (
    <div className="rounded-lg border border-[#263238] bg-[#121212] p-3 sm:p-4 space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h3 className="text-xs sm:text-sm font-bold text-white flex items-center gap-2">
            <Activity className="w-4 h-4 text-[#00E676]" />
            Трафик VPN в реальном времени
          </h3>
          <p className="text-[11px] text-[#78909C]">Пик шкалы: {formatRate(maxRate)} • интервал 2 сек</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="flex items-center gap-1.5 text-[#00E676] font-semibold">
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#00E676]" />
            Вх (Rx): {formatRate(currentRxBps)}
          </span>
          <span className="flex items-center gap-1.5 text-[#80D8FF] font-semibold">
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#80D8FF]" />
            Исх (Tx): {formatRate(currentTxBps)}
          </span>
        </div>
      </div>

      <div className="w-full overflow-hidden rounded border border-[#1E272C] bg-[#0B0E11] p-1">
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-36 sm:h-44 block" preserveAspectRatio="none">
          <defs>
            <linearGradient id="rxGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#00E676" stopOpacity="0.32" />
              <stop offset="100%" stopColor="#00E676" stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id="txGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#80D8FF" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#80D8FF" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Horizontal Grid Lines */}
          {[0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = padTop + chartH * (1 - ratio);
            return (
              <line
                key={ratio}
                x1={padX}
                y1={y}
                x2={width - padX}
                y2={y}
                stroke="#1E272C"
                strokeDasharray="3 3"
                strokeWidth="1"
              />
            );
          })}

          <path d={txArea} fill="url(#txGrad)" />
          <path d={rxArea} fill="url(#rxGrad)" />
          <path d={txLine} fill="none" stroke="#80D8FF" strokeWidth="2" strokeLinejoin="round" />
          <path d={rxLine} fill="none" stroke="#00E676" strokeWidth="2.2" strokeLinejoin="round" />
        </svg>
        <div className="flex justify-between px-2 pb-1 text-[10px] text-[#607D8B]">
          <span>{firstLabel}</span>
          <span>{midLabel}</span>
          <span>{lastLabel}</span>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('server');
  const [snapshot, setSnapshot] = useState<ServerSnapshot | null>(null);
  const [copiedKey, setCopiedKey] = useState<string>('');

  // Client Console State
  const [serverInput, setServerInput] = useState<string>(() => localStorage.getItem('winrm_server') || '127.0.0.1:5986');
  const [pskInput, setPskInput] = useState<string>(() => localStorage.getItem('winrm_psk') || '');
  const [pinInput, setPinInput] = useState<string>(() => localStorage.getItem('winrm_pin') || '');
  const [checkConn, setCheckConn] = useState<boolean>(() => localStorage.getItem('winrm_check_conn') === 'true');
  const [showWatchdogHelp, setShowWatchdogHelp] = useState<boolean>(false);

  const [vpnState, setVpnState] = useState<VpnState>('DISCONNECTED');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [clientError, setClientError] = useState<string>('');
  const [pingResult, setPingResult] = useState<{ ok: boolean | null; text: string }>({ ok: null, text: '' });
  const [ipResult, setIpResult] = useState<{ ok: boolean | null; text: string }>({ ok: null, text: '' });
  const [logs, setLogs] = useState<string[]>([
    `[${timestampNow()}] [INIT] WinRM-VPN v0.3.0 Web Console ready`,
  ]);
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  // Server Panel State
  const [newUserName, setNewUserName] = useState<string>('');
  const [manualPsk, setManualPsk] = useState<string>('');
  const [userFilter, setUserFilter] = useState<'all' | 'online'>('all');
  const [editingPsk, setEditingPsk] = useState<string | null>(null);
  const [editNameVal, setEditNameVal] = useState<string>('');
  const [editPskVal, setEditPskVal] = useState<string>('');

  const [webPortInput, setWebPortInput] = useState<string>('49777');
  const [serverNotice, setServerNotice] = useState<string>('');
  const [speedResult, setSpeedResult] = useState<{
    loading: boolean;
    downloadMbps?: number;
    uploadMbps?: number;
    provider?: string;
    error?: string;
  }>({ loading: false });
  const [showGuide, setShowGuide] = useState<boolean>(false);
  const [goExportCode, setGoExportCode] = useState<string>('');
  const [showGoExport, setShowGoExport] = useState<boolean>(false);

  // Probe Lab State
  const [probeLoading, setProbeLoading] = useState<boolean>(false);
  const [selectedProbe, setSelectedProbe] = useState<string>('wsman_identify');
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);

  const appendLog = useCallback((line: string) => {
    setLogs((prev) => [...prev.slice(-149), `[${timestampNow()}] ${line}`]);
  }, []);

  useEffect(() => {
    if (logBoxRef.current) {
      logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight;
    }
  }, [logs]);

  useEffect(() => {
    localStorage.setItem('winrm_server', serverInput);
  }, [serverInput]);

  useEffect(() => {
    localStorage.setItem('winrm_psk', pskInput);
  }, [pskInput]);

  useEffect(() => {
    localStorage.setItem('winrm_pin', pinInput);
  }, [pinInput]);

  useEffect(() => {
    localStorage.setItem('winrm_check_conn', String(checkConn));
  }, [checkConn]);

  const fetchStats = useCallback(async (refreshIp = false) => {
    try {
      const res = await fetch(refreshIp ? '/api/stats?refreshIp=1' : '/api/stats');
      if (!res.ok) return;
      const data: ServerSnapshot = await res.json();
      setSnapshot(data);
      setPskInput((prev) => (!prev && data.users.length > 0 ? data.users[0].psk : prev));
      setPinInput((prev) => (!prev && data.cert_pin ? data.cert_pin : prev));
    } catch {
      // ignore polling error
    }
  }, []);

  useEffect(() => {
    void fetchStats();
    const timer = window.setInterval(() => {
      void fetchStats(false);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [fetchStats]);

  useEffect(() => {
    if (snapshot?.web_panel_port) {
      setWebPortInput((prev) => (prev === '' ? String(snapshot.web_panel_port) : prev));
    }
  }, [snapshot?.web_panel_port]);

  // Active tunnel heartbeat while CONNECTED
  useEffect(() => {
    if (vpnState !== 'CONNECTED' || !sessionId) return;
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch('/api/tunnel/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_id: sessionId }),
        });
        if (!res.ok) {
          setVpnState('DISCONNECTED');
          setSessionId(null);
          appendLog('[WATCHDOG] Tunnel closed by server or daemon stopped');
          return;
        }
        const data = await res.json();
        if (data.snapshot) setSnapshot(data.snapshot);
        if (checkConn) {
          appendLog(`[WATCHDOG] Keepalive OK (+${data.rxDelta} B rx / +${data.txDelta} B tx)`);
        }
      } catch {
        // ignore transient error
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [vpnState, sessionId, checkConn, appendLog]);

  const showNotice = (msg: string) => {
    setServerNotice(msg);
    window.setTimeout(() => setServerNotice(''), 3500);
  };

  const handleCopy = async (id: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(id);
      window.setTimeout(() => setCopiedKey(''), 1500);
    } catch {
      // ignore clipboard errors
    }
  };

  const validateClientInputs = (): boolean => {
    const srv = serverInput.trim();
    const parts = srv.split(':');
    const port = Number(parts[1]);
    if (!srv || parts.length !== 2 || !parts[0] || !Number.isInteger(port) || port < 1 || port > 65535) {
      setClientError('Ошибка: укажите сервер в формате IP:Port (например, 203.0.113.10:5986).');
      return false;
    }
    if (!pskInput.trim()) {
      setClientError('Ошибка: не указан Pre-Shared Key (PSK).');
      return false;
    }
    const cleanPin = pinInput.trim().replaceAll(':', '');
    if (cleanPin && !/^[0-9a-fA-F]{64}$/.test(cleanPin)) {
      setClientError('Ошибка: SHA-256 Pin должен содержать 64 hex-символа.');
      return false;
    }
    setClientError('');
    return true;
  };

  const handleConnect = async () => {
    if (vpnState === 'CONNECTED' && sessionId) {
      await fetch('/api/tunnel/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      });
      setSessionId(null);
      setVpnState('DISCONNECTED');
      setPingResult({ ok: null, text: '' });
      setIpResult({ ok: null, text: '' });
      appendLog('[VPN] Tunnel disconnected cleanly');
      void fetchStats();
      return;
    }

    if (!validateClientInputs()) return;
    setVpnState('CONNECTING');
    setPingResult({ ok: null, text: '' });
    setIpResult({ ok: null, text: '' });
    appendLog(`[TLS] Connecting to ${serverInput.trim()} (uTLS OpenSSL 3.x / Ansible pywinrm profile)...`);

    try {
      const res = await fetch('/api/tunnel/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          server: serverInput.trim(),
          psk: pskInput.trim(),
          pin: pinInput.trim(),
          check_conn: checkConn,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setVpnState('DISCONNECTED');
        setClientError(data.error || 'Ошибка подключения');
        appendLog(`[ERR] ${data.error || 'Handshake failed'}`);
        return;
      }

      setSessionId(data.session_id);
      setVpnState('CONNECTED');
      if (data.snapshot) setSnapshot(data.snapshot);
      appendLog(`[TLS] Verified Schannel cert pin (${String(data.cert_pin).slice(0, 16)}...) on ${data.emulated_hostname}`);
      appendLog(`[NTLM] Type 1 -> Type 2 challenge (${data.handshake.ntlm_challenge_hex}) -> Type 3 HMAC-SHA256 OK`);
      appendLog(`[WINRM] POST /wsman SOAP CreateShell (${data.handshake.soap_create_shell_bytes} B) -> CreateResponse (${data.handshake.soap_create_response_bytes} B)`);
      appendLog(`[VPN] Подключено! Session ID: ${String(data.session_id).slice(0, 8)}`);
    } catch (err) {
      setVpnState('DISCONNECTED');
      const msg = err instanceof Error ? err.message : 'Network error';
      setClientError(msg);
      appendLog(`[ERR] ${msg}`);
    }
  };

  const handleQuickDemoSession = async () => {
    if (!snapshot || snapshot.users.length === 0) return;
    const targetPsk = pskInput.trim() || snapshot.users[0].psk;
    setPskInput(targetPsk);
    setPinInput(snapshot.cert_pin);
    if (vpnState === 'CONNECTED' && sessionId) {
      await handleConnect();
      return;
    }
    const res = await fetch('/api/tunnel/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        server: serverInput.trim() || '127.0.0.1:5986',
        psk: targetPsk,
        pin: snapshot.cert_pin,
        check_conn: true,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      setSessionId(data.session_id);
      setVpnState('CONNECTED');
      setSnapshot(data.snapshot);
      showNotice('Тестовая VPN-сессия запущена — трафик отображается на диаграмме.');
    } else {
      showNotice(`Ошибка: ${data.error}`);
    }
  };

  const handlePingTest = async () => {
    setPingResult({ ok: null, text: 'Выполняется тестовый ping 8.8.8.8...' });
    appendLog('[PING] Running TCP/TLS reachability probe to 8.8.8.8:443...');
    try {
      const res = await fetch('/api/diagnostics/ping', { method: 'POST' });
      const data = await res.json();
      setPingResult({ ok: Boolean(data.ok), text: data.message });
      appendLog(`[PING] ${data.ok ? 'SUCCESS' : 'FAILED'}: ${data.message}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Ping error';
      setPingResult({ ok: false, text: `✗ Ошибка пинга 8.8.8.8: ${msg}` });
      appendLog(`[PING] EXCEPTION: ${msg}`);
    }
  };

  const handleCheckIp = async () => {
    setIpResult({ ok: null, text: 'Запрос IP и страны через ifconfig.io...' });
    appendLog('[IP-CHECK] Fetching http://ifconfig.io/country_code & /host...');
    try {
      const res = await fetch('/api/diagnostics/ip');
      const data = await res.json();
      if (data.ok) {
        const flag = countryCodeToFlag(data.countryCode);
        const formatted = `${flag} ${data.countryCode}  |  IP/Host: ${data.host}`;
        setIpResult({ ok: true, text: formatted });
        appendLog(`[IP-CHECK] Result: ${formatted}`);
        void fetchStats();
      } else {
        setIpResult({ ok: false, text: `✗ Ошибка проверки IP: ${data.error}` });
        appendLog(`[IP-CHECK] ERROR: ${data.error}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Network error';
      setIpResult({ ok: false, text: `✗ Ошибка проверки IP: ${msg}` });
      appendLog(`[IP-CHECK] ERROR: ${msg}`);
    }
  };

  const handleServerAction = async (action: 'start' | 'stop' | 'restart' | 'reload') => {
    const res = await fetch(`/api/server/${action}`, { method: 'POST' });
    if (res.ok) {
      const data: ServerSnapshot = await res.json();
      setSnapshot(data);
      if (action === 'stop' || action === 'restart') {
        setVpnState('DISCONNECTED');
        setSessionId(null);
      }
      showNotice(
        action === 'start'
          ? 'Сервер WinRM-VPN включён.'
          : action === 'stop'
            ? 'Сервер WinRM-VPN выключен.'
            : action === 'restart'
              ? 'Сервер WinRM-VPN перезапущен.'
              : 'Конфигурация и список PSK перезагружены.',
      );
    }
  };

  const handleUpdateWebPort = async () => {
    const parsed = Number(webPortInput.trim());
    const res = await fetch('/api/server/web-port', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: parsed }),
    });
    const data = await res.json();
    if (!res.ok) {
      showNotice(`Ошибка: ${data.error}`);
      return;
    }
    setSnapshot(data.snapshot);
    showNotice(`Порт веб-панели сохранён: ${data.web_panel_port} (в Linux-бинарнике будет слушать 0.0.0.0:${data.web_panel_port}).`);
  };

  const handleAddUser = async (mode: 'auto' | 'manual') => {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, psk: manualPsk, name: newUserName }),
    });
    const data = await res.json();
    if (!res.ok) {
      showNotice(`Ошибка: ${data.error}`);
      return;
    }
    setManualPsk('');
    setNewUserName('');
    setSnapshot(data.snapshot);
    showNotice(`Добавлен пользователь «${data.user.name}» (${data.user.psk.slice(0, 12)}...)`);
  };

  const startEditUser = (u: UserSnapshot) => {
    setEditingPsk(u.psk);
    setEditNameVal(u.name);
    setEditPskVal(u.psk);
  };

  const handleSaveEditUser = async (oldPsk: string) => {
    const res = await fetch(`/api/users/${encodeURIComponent(oldPsk)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editNameVal, psk: editPskVal }),
    });
    const data = await res.json();
    if (!res.ok) {
      showNotice(`Ошибка: ${data.error}`);
      return;
    }
    if (pskInput === oldPsk) {
      setPskInput(data.user.psk);
    }
    setEditingPsk(null);
    setSnapshot(data.snapshot);
    showNotice(`Пользователь «${data.user.name}» обновлён.`);
  };

  const handleDeleteUser = async (psk: string) => {
    const res = await fetch(`/api/users/${encodeURIComponent(psk)}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) {
      setSnapshot(data.snapshot);
      showNotice('Пользователь удалён.');
    }
  };

  const handleSpeedtest = async () => {
    setSpeedResult({ loading: true });
    try {
      const res = await fetch('/api/diagnostics/speedtest', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        setSpeedResult({
          loading: false,
          downloadMbps: data.downloadMbps,
          uploadMbps: data.uploadMbps,
          provider: data.provider,
        });
      } else {
        setSpeedResult({ loading: false, error: data.error || 'Speedtest failed' });
      }
    } catch (err) {
      setSpeedResult({
        loading: false,
        error: err instanceof Error ? err.message : 'Speedtest error',
      });
    }
  };

  const handleLoadGoExport = async () => {
    if (showGoExport && goExportCode) {
      setShowGoExport(false);
      return;
    }
    const res = await fetch('/api/export/linux-webui-go');
    if (res.ok) {
      const code = await res.text();
      setGoExportCode(code);
      setShowGoExport(true);
    }
  };

  const runProbe = async (probeType: string) => {
    setSelectedProbe(probeType);
    setProbeLoading(true);
    try {
      const res = await fetch('/api/probe/winrm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ probe: probeType }),
      });
      const data: ProbeResult = await res.json();
      setProbeResult(data);
    } finally {
      setProbeLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'probe' && !probeResult) {
      void runProbe('wsman_identify');
    }
  }, [activeTab, probeResult]);

  const displayedUsers = useMemo(() => {
    const list = snapshot?.users ?? [];
    if (userFilter === 'online') {
      return list.filter((u) => u.online);
    }
    return list;
  }, [snapshot?.users, userFilter]);

  return (
    <div className="min-h-screen bg-[#121212] text-[#ECEFF1] font-mono selection:bg-[#00E676]/30 selection:text-[#00E676]">
      <div className="max-w-6xl mx-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4 sm:space-y-5">
        {/* Header with Mobile-Adapted ASCII Logo "WinRM-VPN" */}
        <header className="rounded-lg border border-[#263238] bg-[#171A1E] p-3.5 sm:p-5 shadow-lg">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div className="min-w-0">
              <div className="overflow-x-auto pb-1">
                <pre className="text-[6px] sm:text-[8.5px] md:text-[10px] leading-[1.15] text-[#00E676] select-none whitespace-pre">
                  {ASCII_LOGO}
                </pre>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] sm:text-xs text-[#90A4AE]">
                <span className="px-2 py-0.5 rounded bg-[#00E676]/15 text-[#00E676] border border-[#00E676]/30 font-bold">
                  Release v{snapshot?.version ?? '0.3.0'}
                </span>
                <span>Web Panel :{snapshot?.web_panel_port ?? 49777}</span>
                <span className="hidden sm:inline text-[#455A64]">•</span>
                <span className="hidden sm:inline">Should looks like Ansible</span>
              </div>
            </div>

            {/* Live Server Health Summary (2x2 on mobile) */}
            <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2 sm:gap-3 text-xs">
              <div className="px-2.5 py-2 rounded border border-[#263238] bg-[#121212]">
                <div className="text-[#78909C] text-[10px] uppercase">Сервер</div>
                <div className={`font-semibold flex items-center gap-1.5 truncate ${snapshot?.running ? 'text-[#00E676]' : 'text-[#FF5252]'}`}>
                  <span className={`inline-block h-2 w-2 rounded-full shrink-0 ${snapshot?.running ? 'bg-[#00E676]' : 'bg-[#FF5252]'}`} />
                  {snapshot?.running ? 'АКТИВЕН' : 'ОСТАНОВЛЕН'}
                </div>
              </div>
              <div className="px-2.5 py-2 rounded border border-[#263238] bg-[#121212]">
                <div className="text-[#78909C] text-[10px] uppercase">Активные</div>
                <div className="text-[#ECEFF1] font-semibold">
                  {snapshot?.online_users ?? 0} / {snapshot?.total_users ?? 0} польз.
                </div>
              </div>
              <div className="px-2.5 py-2 rounded border border-[#263238] bg-[#121212]">
                <div className="text-[#78909C] text-[10px] uppercase">Веб-порт</div>
                <div className="text-[#80D8FF] font-semibold">:{snapshot?.web_panel_port ?? 49777}</div>
              </div>
              <div className="px-2.5 py-2 rounded border border-[#263238] bg-[#121212]">
                <div className="text-[#78909C] text-[10px] uppercase">Хост</div>
                <div className="text-[#80D8FF] font-semibold truncate">{snapshot?.emulated_hostname ?? 'WIN-...'}</div>
              </div>
            </div>
          </div>

          {/* Mobile-Friendly Navigation Tabs */}
          <nav className="mt-4 pt-3 border-t border-[#263238] grid grid-cols-1 sm:flex sm:flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setActiveTab('server')}
              className={`px-3.5 py-2.5 sm:py-2 rounded text-xs font-semibold flex items-center justify-center sm:justify-start gap-2 transition-colors cursor-pointer ${
                activeTab === 'server'
                  ? 'bg-[#00E676] text-[#0D1117]'
                  : 'bg-[#121212] text-[#90A4AE] border border-[#263238] hover:text-white'
              }`}
            >
              <Server className="w-3.5 h-3.5" />
              Веб-панель сервера
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('client')}
              className={`px-3.5 py-2.5 sm:py-2 rounded text-xs font-semibold flex items-center justify-center sm:justify-start gap-2 transition-colors cursor-pointer ${
                activeTab === 'client'
                  ? 'bg-[#00E676] text-[#0D1117]'
                  : 'bg-[#121212] text-[#90A4AE] border border-[#263238] hover:text-white'
              }`}
            >
              <Wifi className="w-3.5 h-3.5" />
              Клиент (Android / macOS)
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('probe')}
              className={`px-3.5 py-2.5 sm:py-2 rounded text-xs font-semibold flex items-center justify-center sm:justify-start gap-2 transition-colors cursor-pointer ${
                activeTab === 'probe'
                  ? 'bg-[#00E676] text-[#0D1117]'
                  : 'bg-[#121212] text-[#90A4AE] border border-[#263238] hover:text-white'
              }`}
            >
              <Shield className="w-3.5 h-3.5" />
              WinRM &amp; DPI Probe Lab
            </button>
          </nav>
        </header>

        {/* TAB 1: SERVER WEB PANEL (v0.3.0) */}
        {activeTab === 'server' && (
          <div className="space-y-4 sm:space-y-5">
            {/* 1) Server Controls + Web Port Settings */}
            <section className="rounded-lg border border-[#263238] bg-[#171A1E] p-3.5 sm:p-4 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <h2 className="text-sm font-bold text-[#00E676] flex items-center gap-2">
                  <Server className="w-4 h-4" />
                  Управление сервером WinRM-VPN v{snapshot?.version ?? '0.3.0'}
                </h2>
                <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => handleServerAction('start')}
                    disabled={snapshot?.running}
                    className="px-3 py-2 sm:py-1.5 rounded bg-[#00E676] text-[#0D1117] text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" />
                    Включить
                  </button>
                  <button
                    type="button"
                    onClick={() => handleServerAction('stop')}
                    disabled={!snapshot?.running}
                    className="px-3 py-2 sm:py-1.5 rounded bg-[#FF5252] text-white text-xs font-bold flex items-center justify-center gap-1.5 disabled:opacity-40 cursor-pointer"
                  >
                    <Square className="w-3.5 h-3.5" />
                    Выключить
                  </button>
                  <button
                    type="button"
                    onClick={() => handleServerAction('restart')}
                    className="px-3 py-2 sm:py-1.5 rounded bg-[#FFD54F] text-[#0D1117] text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                    Перезапуск
                  </button>
                  <button
                    type="button"
                    onClick={handleQuickDemoSession}
                    className="px-3 py-2 sm:py-1.5 rounded border border-[#80D8FF]/50 bg-[#121212] text-xs text-[#80D8FF] font-semibold flex items-center justify-center gap-1.5 hover:bg-[#80D8FF]/10 cursor-pointer"
                  >
                    <Wifi className="w-3.5 h-3.5" />
                    {vpnState === 'CONNECTED' ? 'Стоп тест-VPN' : 'Тест-сессия'}
                  </button>
                </div>
              </div>

              {serverNotice && (
                <div className="rounded border border-[#00E676]/40 bg-[#00E676]/10 px-3 py-2 text-xs text-[#00E676]">
                  {serverNotice}
                </div>
              )}

              {/* Metrics Grid */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3 text-xs">
                <div className="rounded border border-[#263238] bg-[#121212] p-3">
                  <div className="text-[#78909C] text-[10px] uppercase">Статус процесса</div>
                  <div className={`mt-1 font-bold ${snapshot?.running ? 'text-[#00E676]' : 'text-[#FF5252]'}`}>
                    {snapshot?.running ? `АКТИВЕН (PID ${snapshot.pid})` : 'ОСТАНОВЛЕН'}
                  </div>
                </div>
                <div className="rounded border border-[#263238] bg-[#121212] p-3">
                  <div className="text-[#78909C] text-[10px] uppercase">Внешний IP</div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="text-white font-semibold truncate">{snapshot?.external_ip ?? '...'}</span>
                    <button
                      type="button"
                      onClick={() => fetchStats(true)}
                      className="text-[#80D8FF] hover:text-white cursor-pointer shrink-0"
                      title="Обновить внешний IP"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <div className="rounded border border-[#263238] bg-[#121212] p-3">
                  <div className="text-[#78909C] text-[10px] uppercase">Время работы</div>
                  <div className="mt-1 text-white font-semibold">
                    {snapshot?.running ? formatDuration(snapshot.uptime_sec) : '0с (остановлен)'}
                  </div>
                </div>
                <div className="rounded border border-[#263238] bg-[#121212] p-3">
                  <div className="text-[#78909C] text-[10px] uppercase">Трафик (с запуска)</div>
                  <div className="mt-1 text-white font-semibold">
                    Вх {formatBytes(snapshot?.total_rx ?? 0)} | Исх {formatBytes(snapshot?.total_tx ?? 0)}
                  </div>
                </div>
              </div>

              {/* Web Panel Port Config (49777 default) + Cert Pin + Speedtest */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 text-xs">
                <div className="rounded border border-[#263238] bg-[#121212] p-3 space-y-2">
                  <div className="text-[#78909C] text-[10px] uppercase">Порт веб-панели (по умолч. 49777)</div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      value={webPortInput}
                      onChange={(e) => setWebPortInput(e.target.value)}
                      className="w-28 rounded border border-[#37474F] bg-[#171A1E] px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#00E676]"
                    />
                    <button
                      type="button"
                      onClick={handleUpdateWebPort}
                      className="flex-1 px-3 py-1.5 rounded bg-[#80D8FF] text-[#0D1117] font-bold text-xs hover:opacity-90 cursor-pointer"
                    >
                      Сменить порт
                    </button>
                  </div>
                  <div className="text-[10px] text-[#78909C]">
                    Активный порт Linux-панели: <span className="text-[#00E676]">0.0.0.0:{snapshot?.web_panel_port ?? 49777}</span>
                  </div>
                </div>

                <div className="rounded border border-[#263238] bg-[#121212] p-3 flex flex-col justify-between gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[#78909C] text-[10px] uppercase truncate">
                      Cert Pin ({snapshot?.emulated_hostname})
                    </span>
                    {snapshot?.cert_pin && (
                      <button
                        type="button"
                        onClick={() => handleCopy('cert_pin', snapshot.cert_pin)}
                        className="text-[#80D8FF] hover:text-white flex items-center gap-1 cursor-pointer shrink-0"
                      >
                        {copiedKey === 'cert_pin' ? <Check className="w-3 h-3 text-[#00E676]" /> : <Copy className="w-3 h-3" />}
                        {copiedKey === 'cert_pin' ? 'OK' : 'Копировать'}
                      </button>
                    )}
                  </div>
                  <code className="text-[10px] sm:text-[11px] text-[#00E676] break-all">{snapshot?.cert_pin}</code>
                </div>

                <div className="rounded border border-[#263238] bg-[#121212] p-3 flex flex-col justify-between gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[#78909C] text-[10px] uppercase">Проверка скорости</span>
                    <button
                      type="button"
                      onClick={handleSpeedtest}
                      disabled={speedResult.loading}
                      className="text-[#00E676] hover:underline flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    >
                      <Zap className="w-3 h-3" />
                      {speedResult.loading ? 'Тест...' : 'Запустить'}
                    </button>
                  </div>
                  {speedResult.loading ? (
                    <div className="text-[#FFD54F]">Измерение Down / Up Mbps...</div>
                  ) : speedResult.error ? (
                    <div className="text-[#FF5252]">{speedResult.error}</div>
                  ) : speedResult.downloadMbps !== undefined ? (
                    <div className="text-white">
                      ↓ <span className="text-[#00E676] font-bold">{speedResult.downloadMbps} Mbps</span>
                      {' | '}
                      ↑ <span className="text-[#80D8FF] font-bold">{speedResult.uploadMbps} Mbps</span>
                    </div>
                  ) : (
                    <div className="text-[#546E7A]">Нажмите «Запустить» для замера</div>
                  )}
                </div>
              </div>

              {/* 4) Real-time VPN Traffic Chart */}
              <RealtimeTrafficChart
                history={snapshot?.traffic_history ?? []}
                currentRxBps={snapshot?.current_rx_bps ?? 0}
                currentTxBps={snapshot?.current_tx_bps ?? 0}
              />

              {/* Secondary Tools: Help & Linux Go Source Export */}
              <div className="flex flex-wrap gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowGuide((v) => !v)}
                  className="px-3 py-1.5 rounded border border-[#37474F] bg-[#121212] text-xs text-[#80D8FF] flex items-center gap-1.5 cursor-pointer"
                >
                  <HelpCircle className="w-3.5 h-3.5" />
                  Справка VPS
                </button>
                <button
                  type="button"
                  onClick={handleLoadGoExport}
                  className="px-3 py-1.5 rounded border border-[#37474F] bg-[#121212] text-xs text-[#00E676] flex items-center gap-1.5 cursor-pointer"
                >
                  <Code2 className="w-3.5 h-3.5" />
                  {showGoExport ? 'Скрыть Go-код (web_panel.go)' : 'Экспорт Go-модуля v0.3.0 для Linux'}
                </button>
              </div>

              {showGuide && (
                <div className="rounded border border-[#37474F] bg-[#121212] p-3 text-xs space-y-2 text-[#CFD8DC]">
                  <div className="font-bold text-[#80D8FF]">Развёртывание Linux-сервера v0.3.0:</div>
                  <pre className="text-[11px] text-[#00E676] overflow-x-auto">
{`ufw allow 5986/tcp
ufw allow ${snapshot?.web_panel_port ?? 49777}/tcp
./winrm-vpn-server -listen 0.0.0.0:5986 -psk "<PSK>"`}
                  </pre>
                </div>
              )}

              {showGoExport && goExportCode && (
                <div className="rounded border border-[#00E676]/40 bg-[#0D0F12] p-3 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-[#00E676] font-bold">cmd/server/web_panel.go (v0.3.0)</span>
                    <button
                      type="button"
                      onClick={() => handleCopy('go-export', goExportCode)}
                      className="text-[#80D8FF] hover:text-white flex items-center gap-1 cursor-pointer"
                    >
                      {copiedKey === 'go-export' ? <Check className="w-3 h-3 text-[#00E676]" /> : <Copy className="w-3 h-3" />}
                      {copiedKey === 'go-export' ? 'Скопировано' : 'Копировать Go-код'}
                    </button>
                  </div>
                  <pre className="text-[10px] sm:text-[11px] text-[#CFD8DC] overflow-x-auto max-h-64 overflow-y-auto">
                    {goExportCode}
                  </pre>
                </div>
              )}
            </section>

            {/* 2) Active Users + 3) User Management (Create, Edit, Delete) */}
            <section className="rounded-lg border border-[#263238] bg-[#171A1E] p-3.5 sm:p-4 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2.5">
                  <h3 className="text-sm font-bold text-white flex items-center gap-2">
                    <Users className="w-4 h-4 text-[#00E676]" />
                    Пользователи VPN ({snapshot?.total_users ?? 0})
                  </h3>
                  <div className="inline-flex rounded border border-[#37474F] bg-[#121212] p-0.5 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setUserFilter('all')}
                      className={`px-2.5 py-1 rounded cursor-pointer ${
                        userFilter === 'all' ? 'bg-[#00E676] text-[#0D1117] font-bold' : 'text-[#90A4AE]'
                      }`}
                    >
                      Все ({snapshot?.total_users ?? 0})
                    </button>
                    <button
                      type="button"
                      onClick={() => setUserFilter('online')}
                      className={`px-2.5 py-1 rounded cursor-pointer ${
                        userFilter === 'online' ? 'bg-[#00E676] text-[#0D1117] font-bold' : 'text-[#90A4AE]'
                      }`}
                    >
                      Активные ({snapshot?.online_users ?? 0})
                    </button>
                  </div>
                </div>
              </div>

              {/* Create User Form (Mobile-adapted) */}
              <div className="rounded border border-[#263238] bg-[#121212] p-3 grid grid-cols-1 sm:grid-cols-12 gap-2 text-xs">
                <input
                  type="text"
                  value={newUserName}
                  onChange={(e) => setNewUserName(e.target.value)}
                  placeholder="Имя / устройство (опц.)"
                  className="sm:col-span-3 rounded border border-[#37474F] bg-[#171A1E] px-3 py-2 text-white placeholder-[#546E7A] focus:outline-none focus:border-[#00E676]"
                />
                <input
                  type="text"
                  value={manualPsk}
                  onChange={(e) => setManualPsk(e.target.value)}
                  placeholder="PSK вручную (или автогенерация)..."
                  className="sm:col-span-5 rounded border border-[#37474F] bg-[#171A1E] px-3 py-2 text-white placeholder-[#546E7A] focus:outline-none focus:border-[#00E676]"
                />
                <button
                  type="button"
                  onClick={() => handleAddUser('manual')}
                  className="sm:col-span-2 px-3 py-2 rounded border border-[#37474F] bg-[#171A1E] hover:border-[#00E676] text-white font-semibold cursor-pointer"
                >
                  Создать
                </button>
                <button
                  type="button"
                  onClick={() => handleAddUser('auto')}
                  className="sm:col-span-2 px-3 py-2 rounded bg-[#00E676] text-[#0D1117] font-bold flex items-center justify-center gap-1 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Авто-PSK
                </button>
              </div>

              {/* Users List */}
              <div className="space-y-2.5">
                {displayedUsers.length === 0 ? (
                  <div className="rounded border border-[#263238] bg-[#121212] p-4 text-center text-xs text-[#78909C]">
                    {userFilter === 'online'
                      ? 'Сейчас нет активных подключений. Запустите «Тест-сессия» или подключитесь во вкладке «Клиент».'
                      : 'Пользователи не найдены.'}
                  </div>
                ) : (
                  displayedUsers.map((u, idx) => {
                    const isEditing = editingPsk === u.psk;
                    return (
                      <div
                        key={u.psk}
                        className="rounded border border-[#263238] bg-[#121212] p-3 space-y-2.5 text-xs"
                      >
                        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
                          <div className="space-y-1.5 min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-[#78909C]">[{idx + 1}]</span>
                              <span className="font-bold text-white">{u.name}</span>
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                  u.online
                                    ? 'bg-[#00E676]/15 text-[#00E676] border border-[#00E676]/40'
                                    : 'bg-[#263238] text-[#90A4AE]'
                                }`}
                              >
                                {u.online ? `ОНЛАЙН (${u.online_conns})` : 'оффлайн'}
                              </span>
                            </div>
                            <code className="block text-[11px] text-[#00E676] break-all">{u.psk}</code>
                            <div className="text-[11px] text-[#90A4AE] flex flex-wrap gap-x-4 gap-y-1">
                              <span>
                                Сессия: <span className="text-[#00E676]">Вх {formatBytes(u.session_rx)}</span> |{' '}
                                <span className="text-[#80D8FF]">Исх {formatBytes(u.session_tx)}</span>
                              </span>
                              <span>
                                Сегодня: Вх {formatBytes(u.today_rx)} | Исх {formatBytes(u.today_tx)}
                              </span>
                              <span>Последнее: {u.last_connected || 'Никогда'}</span>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() => handleCopy(`psk-${u.psk}`, u.psk)}
                              className="px-2.5 py-2 sm:py-1.5 rounded border border-[#37474F] text-[#B0BEC5] hover:text-white flex items-center justify-center gap-1 cursor-pointer"
                            >
                              {copiedKey === `psk-${u.psk}` ? <Check className="w-3 h-3 text-[#00E676]" /> : <Copy className="w-3 h-3" />}
                              Копировать
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setPskInput(u.psk);
                                if (snapshot?.cert_pin) setPinInput(snapshot.cert_pin);
                                setActiveTab('client');
                              }}
                              className="px-2.5 py-2 sm:py-1.5 rounded border border-[#80D8FF]/40 text-[#80D8FF] hover:bg-[#80D8FF]/10 cursor-pointer"
                            >
                              В клиент
                            </button>
                            <button
                              type="button"
                              onClick={() => (isEditing ? setEditingPsk(null) : startEditUser(u))}
                              className="px-2.5 py-2 sm:py-1.5 rounded border border-[#FFD54F]/40 text-[#FFD54F] hover:bg-[#FFD54F]/10 flex items-center justify-center gap-1 cursor-pointer"
                            >
                              <Edit2 className="w-3 h-3" />
                              Изменить
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteUser(u.psk)}
                              className="px-2.5 py-2 sm:py-1.5 rounded border border-[#FF5252]/40 text-[#FF5252] hover:bg-[#FF5252]/10 flex items-center justify-center gap-1 cursor-pointer"
                            >
                              <Trash2 className="w-3 h-3" />
                              Удалить
                            </button>
                          </div>
                        </div>

                        {isEditing && (
                          <div className="pt-2.5 border-t border-[#263238] grid grid-cols-1 sm:grid-cols-12 gap-2">
                            <input
                              type="text"
                              value={editNameVal}
                              onChange={(e) => setEditNameVal(e.target.value)}
                              placeholder="Имя пользователя"
                              className="sm:col-span-3 rounded border border-[#37474F] bg-[#171A1E] px-2.5 py-1.5 text-white focus:outline-none focus:border-[#FFD54F]"
                            />
                            <input
                              type="text"
                              value={editPskVal}
                              onChange={(e) => setEditPskVal(e.target.value)}
                              placeholder="PSK ключ"
                              className="sm:col-span-6 rounded border border-[#37474F] bg-[#171A1E] px-2.5 py-1.5 text-white focus:outline-none focus:border-[#FFD54F]"
                            />
                            <button
                              type="button"
                              onClick={() => handleSaveEditUser(u.psk)}
                              className="sm:col-span-2 px-3 py-1.5 rounded bg-[#00E676] text-[#0D1117] font-bold flex items-center justify-center gap-1 cursor-pointer"
                            >
                              <Save className="w-3 h-3" />
                              Сохранить
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingPsk(null)}
                              className="sm:col-span-1 px-2.5 py-1.5 rounded border border-[#37474F] text-[#90A4AE] hover:text-white flex items-center justify-center cursor-pointer"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </div>
        )}

        {/* TAB 2: CLIENT CONSOLE */}
        {activeTab === 'client' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-5">
            <section className="lg:col-span-5 rounded-lg border border-[#263238] bg-[#171A1E] p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold text-[#00E676] flex items-center gap-2">
                  <KeyRound className="w-4 h-4" />
                  Подключение WinRM-VPN
                </h2>
                <span
                  className={`text-[11px] font-bold px-2 py-0.5 rounded border ${
                    vpnState === 'CONNECTED'
                      ? 'text-[#00E676] border-[#00E676]/40 bg-[#00E676]/10'
                      : vpnState === 'CONNECTING'
                        ? 'text-[#FFD54F] border-[#FFD54F]/40 bg-[#FFD54F]/10'
                        : 'text-[#90A4AE] border-[#37474F] bg-[#121212]'
                  }`}
                >
                  {vpnState === 'CONNECTED'
                    ? 'Подключено'
                    : vpnState === 'CONNECTING'
                      ? 'Подключение...'
                      : 'Отключено'}
                </span>
              </div>

              <div className="space-y-3 text-xs">
                <div>
                  <label className="block text-[#90A4AE] mb-1">Server IP:Port</label>
                  <input
                    type="text"
                    value={serverInput}
                    onChange={(e) => setServerInput(e.target.value)}
                    disabled={vpnState !== 'DISCONNECTED'}
                    placeholder="203.0.113.10:5986"
                    className="w-full rounded border border-[#37474F] bg-[#121212] px-3 py-2 text-white placeholder-[#546E7A] focus:outline-none focus:border-[#00E676] disabled:opacity-60"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[#90A4AE]">Pre-Shared Key (PSK)</label>
                    {snapshot && snapshot.users.length > 0 && vpnState === 'DISCONNECTED' && (
                      <button
                        type="button"
                        onClick={() => setPskInput(snapshot.users[0].psk)}
                        className="text-[11px] text-[#80D8FF] hover:underline cursor-pointer"
                      >
                        Подставить ключ
                      </button>
                    )}
                  </div>
                  <input
                    type="text"
                    value={pskInput}
                    onChange={(e) => setPskInput(e.target.value)}
                    disabled={vpnState !== 'DISCONNECTED'}
                    placeholder="48-char hex PSK"
                    className="w-full rounded border border-[#37474F] bg-[#121212] px-3 py-2 text-white placeholder-[#546E7A] focus:outline-none focus:border-[#00E676] disabled:opacity-60"
                  />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[#90A4AE]">Cert SHA-256 Pin (64 hex, optional)</label>
                    {snapshot?.cert_pin && vpnState === 'DISCONNECTED' && (
                      <button
                        type="button"
                        onClick={() => setPinInput(snapshot.cert_pin)}
                        className="text-[11px] text-[#80D8FF] hover:underline cursor-pointer"
                      >
                        Подставить Pin
                      </button>
                    )}
                  </div>
                  <input
                    type="text"
                    value={pinInput}
                    onChange={(e) => setPinInput(e.target.value)}
                    disabled={vpnState !== 'DISCONNECTED'}
                    placeholder="SHA-256 hex fingerprint"
                    className="w-full rounded border border-[#37474F] bg-[#121212] px-3 py-2 text-white placeholder-[#546E7A] focus:outline-none focus:border-[#00E676] disabled:opacity-60"
                  />
                </div>

                <div className="flex items-center justify-between pt-1">
                  <label className="flex items-center gap-2.5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={checkConn}
                      onChange={(e) => {
                        setCheckConn(e.target.checked);
                        appendLog(`[UI] Проверка соединения (Watchdog): ${e.target.checked ? 'ВКЛ' : 'ВЫКЛ'}`);
                      }}
                      className="accent-[#00E676] h-4 w-4"
                    />
                    <span className="text-white text-xs">Проверять соединение</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowWatchdogHelp((v) => !v)}
                    className="text-[#80D8FF] hover:text-white flex items-center gap-1 text-xs cursor-pointer"
                  >
                    <HelpCircle className="w-3.5 h-3.5" />
                    (?)
                  </button>
                </div>

                {showWatchdogHelp && (
                  <div className="rounded border border-[#80D8FF]/30 bg-[#121212] p-2.5 text-[11px] text-[#B0BEC5] leading-relaxed">
                    Watchdog периодически проверяет живость WinRM/NTLM-сессии и обновляет статистику трафика.
                  </div>
                )}

                {clientError && (
                  <div className="rounded border border-[#FF5252]/40 bg-[#FF5252]/10 p-2.5 text-[11px] text-[#FF5252]">
                    {clientError}
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleConnect}
                  disabled={vpnState === 'CONNECTING'}
                  className={`w-full py-2.5 rounded font-bold text-xs uppercase tracking-wider transition-colors cursor-pointer ${
                    vpnState === 'CONNECTED'
                      ? 'bg-[#FF5252] text-white hover:bg-[#FF5252]/90'
                      : 'bg-[#00E676] text-[#0D1117] hover:bg-[#00C853]'
                  } disabled:opacity-60`}
                >
                  {vpnState === 'CONNECTED'
                    ? 'Disconnect'
                    : vpnState === 'CONNECTING'
                      ? 'Connecting...'
                      : 'Connect'}
                </button>
              </div>

              <div className="pt-3 border-t border-[#263238] space-y-2.5">
                <div className="text-[11px] text-[#90A4AE] uppercase font-semibold">Диагностика сети</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={handlePingTest}
                    className="px-3 py-2 rounded border border-[#37474F] bg-[#121212] hover:border-[#00E676] text-xs text-white flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <Activity className="w-3.5 h-3.5 text-[#00E676]" />
                    Тест ping 8.8.8.8
                  </button>
                  <button
                    type="button"
                    onClick={handleCheckIp}
                    className="px-3 py-2 rounded border border-[#37474F] bg-[#121212] hover:border-[#80D8FF] text-xs text-white flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <Globe className="w-3.5 h-3.5 text-[#80D8FF]" />
                    Проверить IP и страну
                  </button>
                </div>

                {pingResult.text && (
                  <div
                    className={`text-xs px-2.5 py-1.5 rounded bg-[#121212] border border-[#263238] ${
                      pingResult.ok === true
                        ? 'text-[#00E676]'
                        : pingResult.ok === false
                          ? 'text-[#FF5252]'
                          : 'text-[#FFD54F]'
                    }`}
                  >
                    {pingResult.text}
                  </div>
                )}

                {ipResult.text && (
                  <div
                    className={`text-xs px-2.5 py-1.5 rounded bg-[#121212] border border-[#263238] ${
                      ipResult.ok === true
                        ? 'text-[#00E676]'
                        : ipResult.ok === false
                          ? 'text-[#FF5252]'
                          : 'text-[#FFD54F]'
                    }`}
                  >
                    {ipResult.text}
                  </div>
                )}
              </div>
            </section>

            <section className="lg:col-span-7 rounded-lg border border-[#263238] bg-[#171A1E] p-4 flex flex-col">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold text-[#80D8FF] flex items-center gap-2">
                  <Terminal className="w-4 h-4" />
                  Журнал клиента (VpnStateBus)
                </h2>
                <button
                  type="button"
                  onClick={() => setLogs([])}
                  className="text-[11px] text-[#90A4AE] hover:text-white cursor-pointer"
                >
                  Очистить лог
                </button>
              </div>
              <div
                ref={logBoxRef}
                className="flex-1 min-h-[280px] sm:min-h-[340px] max-h-[460px] overflow-y-auto rounded border border-[#263238] bg-[#0D0F12] p-3 text-[11px] leading-relaxed space-y-1"
              >
                {logs.length === 0 ? (
                  <div className="text-[#546E7A]">Лог пуст. Нажмите Connect или запустите диагностику.</div>
                ) : (
                  logs.map((line, i) => (
                    <div
                      key={`${i}-${line.slice(0, 16)}`}
                      className={
                        line.includes('[ERR]') || line.includes('FAILED') || line.includes('ERROR')
                          ? 'text-[#FF5252]'
                          : line.includes('Подключено') || line.includes('SUCCESS') || line.includes('OK')
                            ? 'text-[#00E676]'
                            : line.includes('[NTLM]') || line.includes('[WINRM]')
                              ? 'text-[#80D8FF]'
                              : 'text-[#CFD8DC]'
                      }
                    >
                      {line}
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        )}

        {/* TAB 3: WINRM & DPI PROBE LAB */}
        {activeTab === 'probe' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-5">
            <section className="lg:col-span-4 rounded-lg border border-[#263238] bg-[#171A1E] p-4 space-y-3">
              <h2 className="text-sm font-bold text-[#80D8FF] flex items-center gap-2">
                <ShieldAlert className="w-4 h-4" />
                Active Probing &amp; DPI Тесты
              </h2>
              <p className="text-[11px] text-[#90A4AE] leading-relaxed">
                Проверьте ответы маскировки <code className="text-white">Microsoft-HTTPAPI/2.0</code>, политику <code className="text-white">Schannel AES-GCM</code> и фрагментацию <code className="text-white">TLS-in-TLS</code>.
              </p>

              <div className="space-y-2 text-xs">
                {[
                  { id: 'wsman_identify', label: 'POST /wsman (WS-Man Identify)' },
                  { id: 'bad_request', label: 'Malformed HTTP → http.sys 400' },
                  { id: 'not_found', label: 'GET /unknown → http.sys 404' },
                  { id: 'chacha20_probe', label: 'Schannel ChaCha20 Active Probe' },
                  { id: 'tls_in_tls', label: 'TLS-in-TLS Padding & Split (0x16 0x03)' },
                ].map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => runProbe(item.id)}
                    className={`w-full text-left px-3 py-2.5 rounded border transition-colors cursor-pointer ${
                      selectedProbe === item.id
                        ? 'border-[#00E676] bg-[#00E676]/10 text-[#00E676] font-semibold'
                        : 'border-[#263238] bg-[#121212] text-[#CFD8DC] hover:border-[#546E7A]'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </section>

            <section className="lg:col-span-8 rounded-lg border border-[#263238] bg-[#171A1E] p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-white">Результат инспекции</h3>
                {probeResult && (
                  <span
                    className={`text-xs font-bold px-2 py-0.5 rounded ${
                      probeResult.status < 400
                        ? 'bg-[#00E676]/15 text-[#00E676]'
                        : 'bg-[#FFD54F]/15 text-[#FFD54F]'
                    }`}
                  >
                    HTTP/TLS {probeResult.status} {probeResult.statusText}
                  </span>
                )}
              </div>

              {probeLoading ? (
                <div className="text-xs text-[#FFD54F]">Выполнение пробы...</div>
              ) : probeResult ? (
                <div className="space-y-3 text-xs">
                  {probeResult.notes && (
                    <div className="rounded border border-[#80D8FF]/30 bg-[#121212] p-2.5 text-[11px] text-[#80D8FF]">
                      {probeResult.notes}
                    </div>
                  )}

                  <div className="rounded border border-[#263238] bg-[#121212] p-3">
                    <div className="text-[10px] uppercase text-[#78909C] mb-1.5">Headers / Metadata</div>
                    <div className="space-y-1 text-[11px]">
                      {Object.entries(probeResult.headers).map(([k, v]) => (
                        <div key={k}>
                          <span className="text-[#80D8FF]">{k}:</span> <span className="text-white">{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {probeResult.fragments && (
                    <div className="rounded border border-[#263238] bg-[#121212] p-3">
                      <div className="text-[10px] uppercase text-[#78909C] mb-2">
                        Внешние TLS-рекорды (с динамическим паддингом и микро-джиттером)
                      </div>
                      <div className="space-y-1.5">
                        {probeResult.fragments.map((frag) => (
                          <div key={frag.index} className="flex items-center justify-between text-[11px] border-b border-[#263238]/60 pb-1">
                            <span className="text-[#00E676]">Record #{frag.index}: {frag.recordType}</span>
                            <span className="text-white">{frag.bytes} B (+{frag.jitterMs} ms)</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="rounded border border-[#263238] bg-[#0D0F12] p-3">
                    <div className="text-[10px] uppercase text-[#78909C] mb-1.5">Payload</div>
                    <pre className="text-[11px] text-[#CFD8DC] whitespace-pre-wrap break-all max-h-64 overflow-y-auto">
                      {probeResult.body}
                    </pre>
                  </div>
                </div>
              ) : null}
            </section>
          </div>
        )}

        <footer className="text-[11px] text-[#78909C] border-t border-[#263238] pt-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <span>
            WinRM-VPN <code className="text-[#00E676]">v{snapshot?.version ?? '0.3.0'}</code> • Web Panel target port{' '}
            <code className="text-[#80D8FF]">{snapshot?.web_panel_port ?? 49777}</code>
          </span>
          <span>Адаптивная мобильная веб-панель управления</span>
        </footer>
      </div>
    </div>
  );
}

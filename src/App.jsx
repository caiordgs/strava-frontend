import { useState, useEffect, useRef } from "react";
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  RadarChart, PolarGrid, PolarAngleAxis, Radar
} from "recharts";
import { MapContainer, TileLayer, Polyline, useMap } from "react-leaflet";
import "leaflet/dist/leaflet.css";

const API = import.meta.env.VITE_API_URL || "http://localhost:8000";

// ── Utils ──────────────────────────────────────────────────────────────────
const fmt     = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const fmtDate = (d) => new Date(d + "T00:00:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });

const hrZone = (hr) => {
  if (!hr) return { label: "--", color: "#64748b" };
  if (hr < 130) return { label: "Z1", color: "#60a5fa" };
  if (hr < 145) return { label: "Z2", color: "#34d399" };
  if (hr < 160) return { label: "Z3", color: "#fbbf24" };
  if (hr < 175) return { label: "Z4", color: "#f97316" };
  return { label: "Z5", color: "#f43f5e" };
};

const buildWeeklyData = (runs) => {
  const map = {};
  runs.forEach(r => {
    const d   = new Date(r.date + "T00:00:00");
    const mon = new Date(d);
    mon.setDate(d.getDate() - d.getDay() + 1);
    const key = mon.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
    if (!map[key]) map[key] = { week: key, km: 0, runs: 0 };
    map[key].km = parseFloat((map[key].km + r.distance).toFixed(1));
    map[key].runs++;
  });
  return Object.values(map).slice(-8);
};

const buildPaceTrend = (runs) => {
  // Agrupa pace médio por semana e calcula linha de tendência
  const map = {};
  runs.forEach(r => {
    const d   = new Date(r.date + "T00:00:00");
    const mon = new Date(d);
    mon.setDate(d.getDate() - d.getDay() + 1);
    const key = mon.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
    const [m, s] = r.pace.split(":").map(Number);
    const paceMin = m + s / 60;
    if (!map[key]) map[key] = { week: key, paces: [] };
    map[key].paces.push(paceMin);
  });

  const weeks = Object.values(map).slice(-10).map(w => ({
    week:    w.week,
    pace:    parseFloat((w.paces.reduce((a, b) => a + b, 0) / w.paces.length).toFixed(3)),
    paceStr: (() => { const avg = w.paces.reduce((a, b) => a + b, 0) / w.paces.length; return `${Math.floor(avg)}:${String(Math.round((avg % 1) * 60)).padStart(2,"0")}`; })(),
  }));

  // Linha de tendência linear (regressão simples)
  if (weeks.length < 2) return weeks;
  const n  = weeks.length;
  const xs = weeks.map((_, i) => i);
  const ys = weeks.map(w => w.pace);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const slope = xs.reduce((acc, x, i) => acc + (x - mx) * (ys[i] - my), 0) /
                xs.reduce((acc, x) => acc + (x - mx) ** 2, 0);
  const intercept = my - slope * mx;

  return weeks.map((w, i) => ({
    ...w,
    trend: parseFloat((intercept + slope * i).toFixed(3)),
  }));
};

const buildZoneData = (runs) => {
  const counts = { Z1: 0, Z2: 0, Z3: 0, Z4: 0, Z5: 0 };
  const valid  = runs.filter(r => r.avgHr);
  valid.forEach(r => { const z = hrZone(r.avgHr); counts[z.label]++; });
  const total = valid.length || 1;
  return [
    { zone: "Z1", label: "Recuperação",   range: "< 130 bpm", color: "#60a5fa", pct: Math.round(counts.Z1 / total * 100) },
    { zone: "Z2", label: "Base Aeróbica", range: "130–145",   color: "#34d399", pct: Math.round(counts.Z2 / total * 100) },
    { zone: "Z3", label: "Limiar",        range: "145–160",   color: "#fbbf24", pct: Math.round(counts.Z3 / total * 100) },
    { zone: "Z4", label: "Anaeróbico",    range: "160–175",   color: "#f97316", pct: Math.round(counts.Z4 / total * 100) },
    { zone: "Z5", label: "VO2 Max",       range: "> 175 bpm", color: "#f43f5e", pct: Math.round(counts.Z5 / total * 100) },
  ];
};

const buildRadar = (runs) => {
  if (!runs.length) return [];
  const paces       = runs.map(r => { const [m, s] = r.pace.split(":").map(Number); return m + s / 60; });
  const avgPace     = paces.reduce((a, b) => a + b, 0) / paces.length;
  const maxDist     = Math.max(...runs.map(r => r.distance));
  const hrs         = runs.filter(r => r.avgHr).map(r => r.avgHr);
  const avgHr       = hrs.length ? hrs.reduce((a, b) => a + b, 0) / hrs.length : 150;
  const weeks       = buildWeeklyData(runs);
  const consistency = weeks.length > 0 ? Math.min(100, (weeks.filter(w => w.runs >= 3).length / weeks.length) * 100) : 50;
  return [
    { metric: "Velocidade",   value: Math.round(Math.max(0, Math.min(100, 100 - (avgPace - 4) * 15))) },
    { metric: "Resistência",  value: Math.round(Math.min(100, (maxDist / 42) * 100)) },
    { metric: "Consistência", value: Math.round(consistency) },
    { metric: "Recuperação",  value: Math.round(Math.max(0, Math.min(100, 100 - (avgHr - 120) / 0.7))) },
    { metric: "Intensidade",  value: Math.round(Math.min(100, (avgHr - 100) / 0.9)) },
  ];
};

// Decodifica polyline do Google/Strava
const decodePolyline = (encoded) => {
  if (!encoded) return [];
  let index = 0, lat = 0, lng = 0;
  const coords = [];
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : result >> 1;
    coords.push([lat / 1e5, lng / 1e5]);
  }
  return coords;
};

// ── Componente auxiliar para ajustar bounds do mapa ───────────────────────
const FitBounds = ({ positions }) => {
  const map = useMap();
  useEffect(() => {
    if (positions.length > 1) {
      map.fitBounds(positions, { padding: [20, 20] });
    }
  }, [positions, map]);
  return null;
};

// ── Mapa Leaflet interativo ────────────────────────────────────────────────
const RunMap = ({ polyline, height = 280 }) => {
  const positions = decodePolyline(polyline);
  if (!positions.length) {
    return (
      <div style={{ height, background: "#0a1520", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", color: "#475569", fontSize: 12, border: "1px solid #1e3a4a" }}>
        📍 Sem dados de GPS para esta corrida
      </div>
    );
  }
  const center = positions[Math.floor(positions.length / 2)];
  return (
    <div style={{ height, borderRadius: 10, overflow: "hidden", border: "1px solid #1e3a4a" }}>
      <MapContainer center={center} zoom={14} style={{ height: "100%", width: "100%" }} zoomControl={true} scrollWheelZoom={true}>
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://carto.com/">CARTO</a>'
        />
        <Polyline
          positions={positions}
          pathOptions={{ color: "#f97316", weight: 4, opacity: 0.9, lineCap: "round", lineJoin: "round" }}
        />
        <FitBounds positions={positions} />
      </MapContainer>
    </div>
  );
};

// ── Mini Map SVG (para cards da lista) ────────────────────────────────────
const MiniMap = ({ polyline }) => {
  const pts = decodePolyline(polyline);
  if (!pts.length) return <div style={{ width: 100, height: 60, display: "flex", alignItems: "center", justifyContent: "center", color: "#475569", fontSize: 10 }}>sem GPS</div>;
  const lats = pts.map(p => p[0]), lngs = pts.map(p => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const sx   = (lng) => ((lng - minLng) / (maxLng - minLng || 1)) * 80 + 10;
  const sy   = (lat) => 55 - ((lat - minLat) / (maxLat - minLat || 1)) * 45;
  const step = Math.max(1, Math.floor(pts.length / 80));
  const sampled = pts.filter((_, i) => i % step === 0);
  const d = sampled.map((p, i) => `${i === 0 ? "M" : "L"} ${sx(p[1])} ${sy(p[0])}`).join(" ");
  return (
    <svg width="100" height="60" viewBox="0 0 100 60">
      <path d={d} fill="none" stroke="#f97316" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

// ── Custom Tooltip ─────────────────────────────────────────────────────────
const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#0f1923", border: "1px solid #1e3a4a", borderRadius: 8, padding: "10px 14px" }}>
      <p style={{ color: "#94a3b8", fontSize: 12, marginBottom: 4 }}>{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color || "#f97316", fontSize: 13, fontWeight: 600, margin: 0 }}>
          {p.name}: {p.value}
        </p>
      ))}
    </div>
  );
};

// ── Spinner ────────────────────────────────────────────────────────────────
const Spinner = () => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 300, gap: 16 }}>
    <div style={{ width: 40, height: 40, border: "3px solid #1e3a4a", borderTop: "3px solid #f97316", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
    <p style={{ color: "#475569", fontSize: 12, letterSpacing: 2 }}>CARREGANDO STRAVA...</p>
  </div>
);

// ── Main App ───────────────────────────────────────────────────────────────
export default function StravaApp() {
  const [tab,        setTab]        = useState("dashboard");
  const [runs,       setRuns]       = useState([]);
  const [athlete,    setAthlete]    = useState(null);
  const [selected,   setSelected]   = useState(null);
  const [streams,    setStreams]    = useState(null);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [goals,      setGoals]      = useState([]);
  const [compareA,   setCompareA]   = useState(null);
  const [compareB,   setCompareB]   = useState(null);
  const [streamsA,   setStreamsA]   = useState(null);
  const [streamsB,   setStreamsB]   = useState(null);
  const [loadingCmp, setLoadingCmp] = useState(false);
  const [alerts,     setAlerts]     = useState([]);       // banners ativos
  const [dismissed,  setDismissed]  = useState(new Set()); // alertas fechados
  const [thresholds, setThresholds] = useState({          // % configurável por meta
    "km este mês":           80,
    "média corridas/sem":    80,
    "km este ano":           80,
    "pace últimas 5":        80,
  });

  // Carrega dados da API
  useEffect(() => {
    const load = async () => {
      try {
        const [actRes, athRes] = await Promise.all([
          fetch(`${API}/activities?per_page=50`),
          fetch(`${API}/athlete`),
        ]);
        if (!actRes.ok) throw new Error("Erro ao buscar atividades. Acesse /auth primeiro.");
        const acts = await actRes.json();
        const ath  = athRes.ok ? await athRes.json() : null;
        setRuns(acts);
        setAthlete(ath);

        const now       = new Date();
        const thisMonth = acts.filter(r => { const d = new Date(r.date + "T00:00:00"); return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear(); });
        const thisYear  = acts.filter(r => new Date(r.date + "T00:00:00").getFullYear() === now.getFullYear());
        const weeks     = buildWeeklyData(acts);
        const avgRuns   = weeks.length ? weeks.reduce((a, w) => a + w.runs, 0) / weeks.length : 0;

        // Pace médio das últimas 5 corridas (armazenado como decimal min, ex: 6.5 = 6:30)
        const last5     = acts.slice(0, 5);
        const last5Pace = last5.length
          ? last5.map(r => { const [m, s] = r.pace.split(":").map(Number); return m + s / 60; }).reduce((a, b) => a + b, 0) / last5.length
          : 0;
        const last5PaceStr = last5Pace ? `${Math.floor(last5Pace)}:${String(Math.round((last5Pace % 1) * 60)).padStart(2, "0")}` : "—";
        // Meta padrão de pace: 6:00 = 6.0 decimal
        const paceTarget = 6.0;
        const paceTargetStr = "6:00";

        const newGoals = [
          { id: "km este mês",        label: "km este mês",             current: parseFloat(thisMonth.reduce((a, r) => a + r.distance, 0).toFixed(1)), target: 100,        unit: "km",     color: "#f97316", lowerIsBetter: false },
          { id: "média corridas/sem", label: "corridas no mês",          current: thisMonth.length,                                                          target: 12,         unit: "runs",   color: "#22d3ee", lowerIsBetter: false },
          { id: "km este ano",        label: "km este ano",             current: parseFloat(thisYear.reduce((a, r) => a + r.distance, 0).toFixed(1)),   target: 500,        unit: "km",     color: "#34d399", lowerIsBetter: false },
          { id: "pace últimas 5",     label: "pace últimas 5 corridas", current: last5Pace,  target: paceTarget, unit: "min/km", color: "#a78bfa", lowerIsBetter: true,
            display: last5PaceStr, targetDisplay: paceTargetStr },
        ];
        setGoals(newGoals);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  // Carrega streams ao selecionar corrida
  useEffect(() => {
    if (!selected) { setStreams(null); return; }
    fetch(`${API}/activities/${selected.id}/streams`)
      .then(r => r.ok ? r.json() : null)
      .then(setStreams)
      .catch(() => setStreams(null));
  }, [selected]);

  // Carrega streams das duas corridas ao comparar
  useEffect(() => {
    if (!compareA || !compareB) return;
    setLoadingCmp(true);
    setStreamsA(null); setStreamsB(null);
    Promise.all([
      fetch(`${API}/activities/${compareA.id}/streams`).then(r => r.ok ? r.json() : null),
      fetch(`${API}/activities/${compareB.id}/streams`).then(r => r.ok ? r.json() : null),
    ]).then(([a, b]) => { setStreamsA(a); setStreamsB(b); })
      .catch(() => {})
      .finally(() => setLoadingCmp(false));
  }, [compareA, compareB]);

  // Gera splits por km a partir dos streams
  const buildKmSplits = (streams) => {
    if (!streams?.distance?.data || !streams?.time?.data) return [];
    const dist = streams.distance.data;
    const time = streams.time.data;
    const vel  = streams.velocity_smooth?.data;
    const hr   = streams.heartrate?.data;
    const splits = [];
    let kmTarget = 1000;
    let lastIdx  = 0;
    for (let i = 0; i < dist.length; i++) {
      if (dist[i] >= kmTarget) {
        const elapsed = time[i] - (lastIdx > 0 ? time[lastIdx] : 0);
        const avgVel  = vel ? vel.slice(lastIdx, i).reduce((a, b) => a + b, 0) / (i - lastIdx) : 0;
        const avgHrSeg = hr ? Math.round(hr.slice(lastIdx, i).reduce((a, b) => a + b, 0) / (i - lastIdx)) : null;
        const paceSec = avgVel > 0 ? 1000 / avgVel : elapsed;
        splits.push({
          km:    splits.length + 1,
          pace:  parseFloat((paceSec / 60).toFixed(2)),
          paceStr: `${Math.floor(paceSec / 60)}:${String(Math.round(paceSec % 60)).padStart(2,"0")}`,
          hr:    avgHrSeg,
          time:  elapsed,
          kmh:   parseFloat((avgVel * 3.6).toFixed(1)),
        });
        lastIdx  = i;
        kmTarget += 1000;
      }
    }
    return splits;
  };

  // Gera dados de pace/FC ao longo do tempo para comparação
  const buildCompareStream = (streams, label, color) => {
    if (!streams?.time?.data) return [];
    const step = Math.max(1, Math.floor(streams.time.data.length / 60));
    return streams.time.data
      .filter((_, i) => i % step === 0)
      .map((t, i) => ({
        pct:   Math.round((t / streams.time.data[streams.time.data.length - 1]) * 100),
        [label + "_pace"]: streams.velocity_smooth?.data
          ? parseFloat((streams.velocity_smooth.data[i * step] > 0 ? 1000 / streams.velocity_smooth.data[i * step] / 60 : 0).toFixed(2))
          : null,
        [label + "_hr"]: streams.heartrate?.data?.[i * step] || null,
      }));
  };

  // Calcula alertas sempre que metas ou thresholds mudam
  useEffect(() => {
    if (!goals.length) return;
    const newAlerts = [];
    goals.forEach(g => {
      const thr = thresholds[g.id] ?? 80;
      // Para pace: progresso = quanto o current está abaixo da meta
      // Ex: meta 6:00 (6.0), atual 6:30 (6.5) → pct = (6.0/6.5)*100 = 92% (quase lá)
      // Ex: meta 6:00 (6.0), atual 5:45 (5.75) → pct = (6.0/5.75)*100 = 104% (bateu!)
      const pct = g.lowerIsBetter
        ? Math.min(110, (g.target / (g.current || 1)) * 100)
        : Math.min(100, (g.current / g.target) * 100);

      const remaining = g.lowerIsBetter
        ? g.current - g.target   // segundos a ganhar de pace
        : g.target - g.current;

      // Formata "faltam X" para pace em min:seg
      const remainingStr = g.lowerIsBetter
        ? (() => { const secs = remaining * 60; return `${Math.floor(Math.abs(secs) / 60)}:${String(Math.round(Math.abs(secs) % 60)).padStart(2,"0")} min/km`; })()
        : `${Math.abs(remaining).toFixed(1)} ${g.unit}`;

      const currentLabel = g.display || g.current;

      if (pct >= 100) {
        newAlerts.push({ id: g.id, type: "success", color: g.color, icon: "🎯", title: `Meta atingida: ${g.label}!`, msg: `Atual: ${currentLabel} ${g.unit}. Parabéns!` });
      } else if (pct >= thr) {
        newAlerts.push({ id: g.id, type: "warning", color: g.color, icon: "🔔", title: `Quase lá: ${g.label}`, msg: `${pct.toFixed(0)}% — faltam ${remainingStr} para bater a meta.` });
      }
    });
    setAlerts(newAlerts);
  }, [goals, thresholds]);

  const weeklyData   = buildWeeklyData(runs);
  const paceTrendData = buildPaceTrend(runs);
  const radarData    = buildRadar(runs);
  const zoneData    = buildZoneData(runs);
  const totalKm     = runs.reduce((a, r) => a + r.distance, 0).toFixed(1);
  const paceArr     = runs.map(r => { const [m, s] = r.pace.split(":").map(Number); return m + s / 60; });
  const avgPaceMin  = paceArr.length ? paceArr.reduce((a, b) => a + b, 0) / paceArr.length : 0;
  const avgPaceStr  = `${Math.floor(avgPaceMin)}:${String(Math.round((avgPaceMin % 1) * 60)).padStart(2, "0")}`;
  const totalCal    = runs.reduce((a, r) => a + (r.calories || 0), 0);

  const hrStreamData = streams?.heartrate?.data
    ? streams.heartrate.data.filter((_, i) => i % 5 === 0).map((hr, i) => ({ min: streams.time?.data?.[i * 5] || i * 5, hr }))
    : null;

  const tabs = ["dashboard", "histórico", "comparar", "metas", "frequência"];

  return (
    <div style={{ minHeight: "100vh", background: "#060d14", fontFamily: "'DM Mono','Courier New',monospace", color: "#e2e8f0" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Bebas+Neue&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: #0f1923; }
        ::-webkit-scrollbar-thumb { background: #f97316; border-radius: 4px; }
        .run-card:hover { border-color: #f97316 !important; transform: translateY(-2px); }
        .tab-btn:hover { color: #f97316 !important; }
        @keyframes fadeUp { from { opacity:0; transform:translateY(20px); } to { opacity:1; transform:translateY(0); } }
        .fade-up { animation: fadeUp 0.4s ease forwards; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .leaflet-container { background: #0a1520 !important; }
        .leaflet-control-zoom a { background: #0f1923 !important; color: #f97316 !important; border-color: #1e3a4a !important; }
        .leaflet-control-attribution { background: #0a152099 !important; color: #475569 !important; font-size: 9px !important; }
        .leaflet-control-attribution a { color: #64748b !important; }
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: "1px solid #1e3a4a", padding: "20px 32px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 36, height: 36, background: "#f97316", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🏃</div>
          <div>
            <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 22, letterSpacing: 3, color: "#f97316" }}>
              {athlete ? `${athlete.firstname} ${athlete.lastname}`.toUpperCase() : "STRAVA DASHBOARD"}
            </div>
            <div style={{ fontSize: 11, color: "#64748b", letterSpacing: 1 }}>
              {athlete ? `${athlete.city || ""} · ${runs.length} corridas registradas` : "CORRIDAS • ANÁLISE • PROGRESSO"}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {tabs.map(t => (
            <button key={t} className="tab-btn" onClick={() => setTab(t)} style={{
              background: tab === t ? "#f97316" : "transparent", color: tab === t ? "#000" : "#64748b",
              border: `1px solid ${tab === t ? "#f97316" : "#1e3a4a"}`, padding: "8px 18px", borderRadius: 6,
              cursor: "pointer", fontSize: 12, fontFamily: "inherit", fontWeight: 500,
              textTransform: "uppercase", letterSpacing: 1, transition: "all 0.2s"
            }}>{t}</button>
          ))}
        </div>
      </div>

      {/* Banners de notificação */}
      {alerts.filter(a => !dismissed.has(a.id)).length > 0 && (
        <div style={{ padding: "0 32px 0", display: "grid", gap: 8, marginTop: 16 }}>
          {alerts.filter(a => !dismissed.has(a.id)).map(a => (
            <div key={a.id} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              background: a.type === "success" ? `${a.color}18` : "#0f1923",
              border: `1px solid ${a.color}55`,
              borderLeft: `4px solid ${a.color}`,
              borderRadius: 10, padding: "12px 16px",
              animation: "fadeUp 0.3s ease"
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 20 }}>{a.icon}</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: a.color }}>{a.title}</div>
                  <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{a.msg}</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <button onClick={() => setTab("metas")} style={{ background: `${a.color}22`, border: `1px solid ${a.color}55`, color: a.color, padding: "4px 12px", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 11 }}>ver meta</button>
                <button onClick={() => setDismissed(prev => new Set([...prev, a.id]))} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 16, lineHeight: 1 }}>✕</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ padding: "32px", maxWidth: 1400, margin: "0 auto" }}>
        {loading && <Spinner />}

        {error && (
          <div style={{ background: "#1a0a0a", border: "1px solid #f43f5e44", borderRadius: 12, padding: 32, textAlign: "center" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
            <div style={{ color: "#f43f5e", fontSize: 14, marginBottom: 12 }}>{error}</div>
            <a href="http://localhost:8000/auth" target="_blank" rel="noreferrer" style={{ color: "#f97316", fontSize: 12, textDecoration: "underline" }}>
              Clique aqui para autenticar com a Strava
            </a>
          </div>
        )}

        {!loading && !error && (
          <>
            {/* ── DASHBOARD ── */}
            {tab === "dashboard" && (
              <div className="fade-up">
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 24 }}>
                  {[
                    { label: "TOTAL KM",    value: totalKm,              unit: "km",        icon: "📍" },
                    { label: "CORRIDAS",    value: runs.length,          unit: "atividades", icon: "🔥" },
                    { label: "PACE MÉDIO",  value: avgPaceStr,           unit: "min/km",    icon: "⚡" },
                    { label: "CALORIAS",    value: totalCal || "—",      unit: totalCal ? "kcal" : "sem dados", icon: "💥" },
                  ].map((kpi, i) => (
                    <div key={i} style={{ background: "#0f1923", border: "1px solid #1e3a4a", borderRadius: 12, padding: "20px 24px", borderTop: "3px solid #f97316" }}>
                      <div style={{ fontSize: 20, marginBottom: 8 }}>{kpi.icon}</div>
                      <div style={{ fontSize: 28, fontFamily: "'Bebas Neue',sans-serif", letterSpacing: 2 }}>{kpi.value}</div>
                      <div style={{ fontSize: 11, color: "#64748b", letterSpacing: 1 }}>{kpi.unit}</div>
                      <div style={{ fontSize: 10, color: "#475569", marginTop: 4, letterSpacing: 1 }}>{kpi.label}</div>
                    </div>
                  ))}
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
                  <div style={{ background: "#0f1923", border: "1px solid #1e3a4a", borderRadius: 12, padding: 24 }}>
                    <div style={{ fontSize: 11, letterSpacing: 2, color: "#64748b", marginBottom: 16 }}>KM POR SEMANA</div>
                    <ResponsiveContainer width="100%" height={200}>
                      <AreaChart data={weeklyData}>
                        <defs>
                          <linearGradient id="kmGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#f97316" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#f97316" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke="#1e3a4a" strokeDasharray="3 3" />
                        <XAxis dataKey="week" tick={{ fill: "#475569", fontSize: 10 }} />
                        <YAxis tick={{ fill: "#475569", fontSize: 10 }} />
                        <Tooltip content={<CustomTooltip />} />
                        <Area type="monotone" dataKey="km" stroke="#f97316" fill="url(#kmGrad)" strokeWidth={2} dot={{ fill: "#f97316", r: 3 }} name="km" />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                  <div style={{ background: "#0f1923", border: "1px solid #1e3a4a", borderRadius: 12, padding: 24 }}>
                    <div style={{ fontSize: 11, letterSpacing: 2, color: "#64748b", marginBottom: 16 }}>PERFIL DE PERFORMANCE</div>
                    <ResponsiveContainer width="100%" height={200}>
                      <RadarChart data={radarData}>
                        <PolarGrid stroke="#1e3a4a" />
                        <PolarAngleAxis dataKey="metric" tick={{ fill: "#475569", fontSize: 10 }} />
                        <Radar dataKey="value" stroke="#f97316" fill="#f97316" fillOpacity={0.2} />
                      </RadarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Tendência de pace */}
                {paceTrendData.length >= 2 && (() => {
                  const first = paceTrendData[0].trend;
                  const last  = paceTrendData[paceTrendData.length - 1].trend;
                  const improving = last < first;
                  const diffSec   = Math.round(Math.abs(last - first) * 60);
                  const diffStr   = `${Math.floor(diffSec / 60) > 0 ? `${Math.floor(diffSec/60)}min ` : ""}${diffSec % 60}s`;
                  return (
                    <div style={{ background: "#0f1923", border: "1px solid #1e3a4a", borderRadius: 12, padding: 24, marginBottom: 24 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
                        <div>
                          <div style={{ fontSize: 11, letterSpacing: 2, color: "#64748b" }}>TENDÊNCIA DE PACE</div>
                          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>pace médio semanal · últimas {paceTrendData.length} semanas</div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontSize: 13, color: improving ? "#34d399" : "#f43f5e", fontWeight: 500 }}>
                            {improving ? "▼ melhorando" : "▲ piorando"} {diffStr}/km
                          </div>
                          <div style={{ fontSize: 10, color: "#475569", marginTop: 2 }}>
                            {paceTrendData[0].paceStr} → {paceTrendData[paceTrendData.length-1].paceStr} /km
                          </div>
                        </div>
                      </div>
                      <ResponsiveContainer width="100%" height={200}>
                        <LineChart data={paceTrendData}>
                          <defs>
                            <linearGradient id="trendGrad" x1="0" y1="0" x2="1" y2="0">
                              <stop offset="0%" stopColor={improving ? "#f43f5e" : "#34d399"} />
                              <stop offset="100%" stopColor={improving ? "#34d399" : "#f43f5e"} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid stroke="#1e3a4a" strokeDasharray="3 3" />
                          <XAxis dataKey="week" tick={{ fill: "#475569", fontSize: 10 }} />
                          <YAxis
                            domain={["auto", "auto"]}
                            tick={{ fill: "#475569", fontSize: 10 }}
                            tickFormatter={v => { const m = Math.floor(v); const s = Math.round((v-m)*60); return `${m}:${String(s).padStart(2,"0")}`; }}
                            reversed
                          />
                          <Tooltip
                            content={<CustomTooltip />}
                            formatter={(v, name) => {
                              const m = Math.floor(v); const s = Math.round((v-m)*60);
                              return [`${m}:${String(s).padStart(2,"0")} /km`, name === "pace" ? "Pace médio" : "Tendência"];
                            }}
                          />
                          <Line type="monotone" dataKey="pace"  stroke="#94a3b8" strokeWidth={2} dot={{ fill: "#94a3b8", r: 4 }} name="pace" />
                          <Line type="monotone" dataKey="trend" stroke="url(#trendGrad)" strokeWidth={2} strokeDasharray="6 3" dot={false} name="trend" />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  );
                })()}

                {/* Últimas corridas com mapa da mais recente */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                  <div style={{ background: "#0f1923", border: "1px solid #1e3a4a", borderRadius: 12, padding: 24 }}>
                    <div style={{ fontSize: 11, letterSpacing: 2, color: "#64748b", marginBottom: 16 }}>ÚLTIMAS CORRIDAS</div>
                    <div style={{ display: "grid", gap: 10 }}>
                      {runs.slice(0, 5).map(run => {
                        const zone = hrZone(run.avgHr);
                        return (
                          <div key={run.id} className="run-card"
                            onClick={() => { setSelected(run); setTab("histórico"); }}
                            style={{ background: "#0a1520", border: "1px solid #1e3a4a", borderRadius: 8, padding: "12px 16px", cursor: "pointer", transition: "all 0.2s", display: "grid", gridTemplateColumns: "1fr auto auto auto auto", alignItems: "center", gap: 16 }}>
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 500 }}>{run.name}</div>
                              <div style={{ fontSize: 10, color: "#475569" }}>{fmtDate(run.date)}</div>
                            </div>
                            <div style={{ textAlign: "center" }}>
                              <div style={{ fontSize: 16, fontFamily: "'Bebas Neue'", color: "#f97316" }}>{run.distance}</div>
                              <div style={{ fontSize: 9, color: "#475569" }}>km</div>
                            </div>
                            <div style={{ textAlign: "center" }}>
                              <div style={{ fontSize: 13 }}>{run.pace}</div>
                              <div style={{ fontSize: 9, color: "#475569" }}>pace</div>
                            </div>
                            <div>
                              {run.avgHr
                                ? <span style={{ background: zone.color + "22", color: zone.color, border: `1px solid ${zone.color}55`, borderRadius: 4, padding: "2px 6px", fontSize: 10 }}>{zone.label} · {run.avgHr}</span>
                                : <span style={{ color: "#475569", fontSize: 10 }}>sem FC</span>}
                            </div>
                            <MiniMap polyline={run.polyline} />
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Mapa da corrida mais recente no dashboard */}
                  <div style={{ background: "#0f1923", border: "1px solid #1e3a4a", borderRadius: 12, padding: 24 }}>
                    <div style={{ fontSize: 11, letterSpacing: 2, color: "#64748b", marginBottom: 4 }}>ÚLTIMA CORRIDA — ROTA GPS</div>
                    {runs[0] && <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 12 }}>{runs[0].name} · {fmtDate(runs[0].date)}</div>}
                    {runs[0] ? <RunMap polyline={runs[0].polyline} height={280} /> : <Spinner />}
                  </div>
                </div>
              </div>
            )}

            {/* ── HISTÓRICO ── */}
            {tab === "histórico" && (
              <div className="fade-up" style={{ display: "grid", gridTemplateColumns: selected ? "1fr 1fr" : "1fr", gap: 20 }}>
                <div>
                  <div style={{ fontSize: 11, letterSpacing: 2, color: "#64748b", marginBottom: 16 }}>TODAS AS CORRIDAS ({runs.length})</div>
                  <div style={{ display: "grid", gap: 10 }}>
                    {runs.map(run => {
                      const zone  = hrZone(run.avgHr);
                      const isSel = selected?.id === run.id;
                      return (
                        <div key={run.id} className="run-card" onClick={() => setSelected(isSel ? null : run)}
                          style={{ background: isSel ? "#1a2535" : "#0f1923", border: `1px solid ${isSel ? "#f97316" : "#1e3a4a"}`, borderRadius: 10, padding: "16px 20px", cursor: "pointer", transition: "all 0.2s" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                            <div>
                              <div style={{ fontSize: 15, fontWeight: 500 }}>{run.name}</div>
                              <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>{fmtDate(run.date)}</div>
                            </div>
                            <MiniMap polyline={run.polyline} />
                          </div>
                          <div style={{ display: "flex", gap: 20, marginTop: 12, flexWrap: "wrap" }}>
                            {[
                              { v: `${run.distance}km`, l: "distância" },
                              { v: fmt(run.duration),   l: "tempo" },
                              { v: run.pace,            l: "pace" },
                              { v: `↑${run.elevation}m`, l: "elevação" },
                              run.calories ? { v: `${run.calories}kcal`, l: "calorias" } : null,
                            ].filter(Boolean).map((s, i) => (
                              <div key={i}>
                                <div style={{ fontSize: 15, fontFamily: "'Bebas Neue'", color: "#f97316" }}>{s.v}</div>
                                <div style={{ fontSize: 10, color: "#475569" }}>{s.l}</div>
                              </div>
                            ))}
                            {run.avgHr && (
                              <span style={{ background: zone.color + "22", color: zone.color, border: `1px solid ${zone.color}55`, borderRadius: 4, padding: "2px 8px", fontSize: 11, alignSelf: "center" }}>
                                {zone.label} · {run.avgHr} bpm
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Painel lateral com mapa Leaflet */}
                {selected && (
                  <div style={{ background: "#0f1923", border: "1px solid #1e3a4a", borderRadius: 12, padding: 24, height: "fit-content", position: "sticky", top: 20 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                      <div>
                        <div style={{ fontSize: 20, fontFamily: "'Bebas Neue'", letterSpacing: 2, color: "#f97316" }}>{selected.name}</div>
                        <div style={{ fontSize: 11, color: "#64748b" }}>{fmtDate(selected.date)}</div>
                      </div>
                      <button onClick={() => setSelected(null)} style={{ background: "none", border: "1px solid #1e3a4a", color: "#64748b", padding: "4px 12px", borderRadius: 6, cursor: "pointer", fontFamily: "inherit" }}>✕</button>
                    </div>

                    {/* Mapa interativo */}
                    <div style={{ marginBottom: 16 }}>
                      <RunMap polyline={selected.polyline} height={240} />
                    </div>

                    {/* Stats */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
                      {[
                        { l: "Distância",    v: `${selected.distance} km` },
                        { l: "Tempo",        v: fmt(selected.duration) },
                        { l: "Pace",         v: `${selected.pace} /km` },
                        { l: "Velocidade",   v: selected.avgSpeed ? `${selected.avgSpeed} km/h` : "—" },
                        { l: "Vel. Máxima",  v: selected.maxSpeed ? `${selected.maxSpeed} km/h` : "—" },
                        { l: "Elevação",     v: `${selected.elevation} m` },
                        { l: "FC Média",     v: selected.avgHr ? `${selected.avgHr} bpm` : "—" },
                        { l: "FC Máxima",    v: selected.maxHr ? `${selected.maxHr} bpm` : "—" },
                        { l: "Calorias",     v: selected.calories ? `${selected.calories} kcal` : "—" },
                        { l: "Zona FC",      v: hrZone(selected.avgHr).label },
                      ].map((s, i) => (
                        <div key={i} style={{ background: "#0a1520", borderRadius: 8, padding: "10px 14px" }}>
                          <div style={{ fontSize: 10, color: "#475569", letterSpacing: 1 }}>{s.l.toUpperCase()}</div>
                          <div style={{ fontSize: 16, fontFamily: "'Bebas Neue'", color: "#e2e8f0", letterSpacing: 1, marginTop: 2 }}>{s.v}</div>
                        </div>
                      ))}
                    </div>

                    {/* Gráfico FC */}
                    {hrStreamData ? (
                      <>
                        <div style={{ fontSize: 11, color: "#64748b", letterSpacing: 1, marginBottom: 10 }}>FC AO LONGO DA CORRIDA</div>
                        <ResponsiveContainer width="100%" height={130}>
                          <AreaChart data={hrStreamData}>
                            <defs>
                              <linearGradient id="hrGrad" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.3} />
                                <stop offset="95%" stopColor="#f43f5e" stopOpacity={0} />
                              </linearGradient>
                            </defs>
                            <CartesianGrid stroke="#1e3a4a" strokeDasharray="3 3" />
                            <XAxis dataKey="min" tick={{ fill: "#475569", fontSize: 9 }} tickFormatter={v => `${Math.floor(v/60)}min`} />
                            <YAxis domain={["auto","auto"]} tick={{ fill: "#475569", fontSize: 9 }} />
                            <Tooltip content={<CustomTooltip />} />
                            <Area type="monotone" dataKey="hr" stroke="#f43f5e" fill="url(#hrGrad)" strokeWidth={2} dot={false} name="bpm" />
                          </AreaChart>
                        </ResponsiveContainer>
                      </>
                    ) : (
                      <div style={{ color: "#475569", fontSize: 11, textAlign: "center", padding: 12 }}>
                        {selected.avgHr ? "Carregando dados de FC..." : "Corrida sem dados de FC"}
                      </div>
                    )}

                    {/* Gráfico Velocidade */}
                    {(() => {
                      const velData = streams?.velocity_smooth?.data
                        ? streams.velocity_smooth.data
                            .filter((_, i) => i % 5 === 0)
                            .map((v, i) => ({
                              min: streams.time?.data?.[i * 5] || i * 5,
                              kmh: parseFloat((v * 3.6).toFixed(1)),
                            }))
                            .filter(d => d.kmh > 0)
                        : null;
                      return velData ? (
                        <>
                          <div style={{ fontSize: 11, color: "#64748b", letterSpacing: 1, marginBottom: 10, marginTop: 16 }}>VELOCIDADE AO LONGO DA CORRIDA</div>
                          <ResponsiveContainer width="100%" height={130}>
                            <AreaChart data={velData}>
                              <defs>
                                <linearGradient id="velGrad" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="5%" stopColor="#f97316" stopOpacity={0.3} />
                                  <stop offset="95%" stopColor="#f97316" stopOpacity={0} />
                                </linearGradient>
                              </defs>
                              <CartesianGrid stroke="#1e3a4a" strokeDasharray="3 3" />
                              <XAxis dataKey="min" tick={{ fill: "#475569", fontSize: 9 }} tickFormatter={v => `${Math.floor(v/60)}min`} />
                              <YAxis domain={["auto","auto"]} tick={{ fill: "#475569", fontSize: 9 }} unit=" km/h" width={52} />
                              <Tooltip content={<CustomTooltip />} formatter={v => [`${v} km/h`]} />
                              <Area type="monotone" dataKey="kmh" stroke="#f97316" fill="url(#velGrad)" strokeWidth={2} dot={false} name="km/h" />
                            </AreaChart>
                          </ResponsiveContainer>
                        </>
                      ) : null;
                    })()}
                  </div>
                )}
              </div>
            )}

            {/* ── COMPARAR ── */}
            {tab === "comparar" && (
              <div className="fade-up">
                <div style={{ fontSize: 11, letterSpacing: 2, color: "#64748b", marginBottom: 20 }}>COMPARATIVO DE CORRIDAS</div>

                {/* Seletores */}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
                  {[{ label: "CORRIDA A", color: "#f97316", value: compareA, setter: setCompareA },
                    { label: "CORRIDA B", color: "#22d3ee", value: compareB, setter: setCompareB }
                  ].map(({ label, color, value, setter }) => (
                    <div key={label} style={{ background: "#0f1923", border: `1px solid ${color}44`, borderTop: `3px solid ${color}`, borderRadius: 12, padding: 20 }}>
                      <div style={{ fontSize: 11, letterSpacing: 2, color, marginBottom: 12 }}>{label}</div>
                      {value ? (
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div>
                            <div style={{ fontSize: 15, fontWeight: 500 }}>{value.name}</div>
                            <div style={{ fontSize: 11, color: "#64748b" }}>{fmtDate(value.date)} · {value.distance}km · {value.pace}/km</div>
                          </div>
                          <button onClick={() => setter(null)} style={{ background: "none", border: "1px solid #1e3a4a", color: "#64748b", padding: "4px 10px", borderRadius: 6, cursor: "pointer", fontFamily: "inherit", fontSize: 12 }}>trocar</button>
                        </div>
                      ) : (
                        <div style={{ color: "#475569", fontSize: 12 }}>Selecione uma corrida abaixo ↓</div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Lista de seleção */}
                {(!compareA || !compareB) && (
                  <div style={{ background: "#0f1923", border: "1px solid #1e3a4a", borderRadius: 12, padding: 20, marginBottom: 24 }}>
                    <div style={{ fontSize: 11, letterSpacing: 2, color: "#64748b", marginBottom: 12 }}>
                      SELECIONE {!compareA ? "A CORRIDA A" : "A CORRIDA B"}
                    </div>
                    <div style={{ display: "grid", gap: 8, maxHeight: 280, overflowY: "auto" }}>
                      {runs.map(run => {
                        const isA   = compareA?.id === run.id;
                        const isB   = compareB?.id === run.id;
                        const taken = isA || isB;
                        return (
                          <div key={run.id}
                            onClick={() => { if (taken) return; if (!compareA) setCompareA(run); else if (!compareB) setCompareB(run); }}
                            style={{ background: taken ? "#1a2535" : "#0a1520", border: `1px solid ${isA ? "#f97316" : isB ? "#22d3ee" : "#1e3a4a"}`, borderRadius: 8, padding: "10px 16px", cursor: taken ? "default" : "pointer", transition: "all 0.15s", display: "flex", justifyContent: "space-between", alignItems: "center", opacity: taken ? 0.5 : 1 }}>
                            <div>
                              <span style={{ fontSize: 13, fontWeight: 500 }}>{run.name}</span>
                              <span style={{ fontSize: 11, color: "#64748b", marginLeft: 12 }}>{fmtDate(run.date)}</span>
                            </div>
                            <div style={{ display: "flex", gap: 16, fontSize: 12 }}>
                              <span style={{ color: "#f97316", fontFamily: "'Bebas Neue'" }}>{run.distance}km</span>
                              <span style={{ color: "#94a3b8" }}>{run.pace}/km</span>
                              {run.avgHr && <span style={{ color: "#f43f5e" }}>{run.avgHr}bpm</span>}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Gráficos de comparação */}
                {compareA && compareB && (
                  <>
                    {loadingCmp ? (
                      <Spinner />
                    ) : (
                      <>
                        {/* Cabeçalho de stats comparativos */}
                        <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 12, marginBottom: 20, background: "#0f1923", borderRadius: 12, border: "1px solid #1e3a4a", padding: 20 }}>
                          {[
                            { label: "Distância", a: `${compareA.distance}km`, b: `${compareB.distance}km` },
                            { label: "Pace",      a: compareA.pace,            b: compareB.pace },
                            { label: "Vel. Méd.", a: compareA.avgSpeed ? `${compareA.avgSpeed}km/h` : "—", b: compareB.avgSpeed ? `${compareB.avgSpeed}km/h` : "—" },
                            { label: "Vel. Máx.", a: compareA.maxSpeed ? `${compareA.maxSpeed}km/h` : "—", b: compareB.maxSpeed ? `${compareB.maxSpeed}km/h` : "—" },
                            { label: "FC Média",  a: compareA.avgHr ? `${compareA.avgHr}bpm` : "—", b: compareB.avgHr ? `${compareB.avgHr}bpm` : "—" },
                            { label: "Tempo",     a: fmt(compareA.duration),   b: fmt(compareB.duration) },
                            { label: "Elevação",  a: `${compareA.elevation}m`, b: `${compareB.elevation}m` },
                          ].map((s, i) => (
                            <div key={i} style={{ display: "contents" }}>
                              <div style={{ textAlign: "right", padding: "6px 0" }}>
                                <span style={{ fontFamily: "'Bebas Neue'", fontSize: 18, color: "#f97316" }}>{s.a}</span>
                              </div>
                              <div style={{ textAlign: "center", padding: "6px 12px" }}>
                                <div style={{ fontSize: 10, color: "#475569", letterSpacing: 1 }}>{s.label.toUpperCase()}</div>
                              </div>
                              <div style={{ textAlign: "left", padding: "6px 0" }}>
                                <span style={{ fontFamily: "'Bebas Neue'", fontSize: 18, color: "#22d3ee" }}>{s.b}</span>
                              </div>
                            </div>
                          ))}
                        </div>

                        {/* Splits por km — visual */}
                        {(() => {
                          const splitsA = buildKmSplits(streamsA);
                          const splitsB = buildKmSplits(streamsB);
                          const maxKm   = Math.max(splitsA.length, splitsB.length);
                          const pFmt = (v) => { if (!v) return "—"; const m = Math.floor(v); const s = Math.round((v-m)*60); return `${m}:${String(s).padStart(2,"0")}`; };

                          return maxKm > 0 ? (
                            <div style={{ background: "#0f1923", border: "1px solid #1e3a4a", borderRadius: 12, padding: 20 }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                                <div style={{ fontSize: 11, letterSpacing: 2, color: "#64748b" }}>SPLITS POR KM</div>
                                <div style={{ display: "flex", gap: 20 }}>
                                  <span style={{ fontSize: 11, color: "#f97316" }}>● {compareA.name}</span>
                                  <span style={{ fontSize: 11, color: "#22d3ee" }}>● {compareB.name}</span>
                                </div>
                              </div>

                              <div style={{ display: "grid", gap: 10 }}>
                                {Array.from({ length: maxKm }, (_, i) => {
                                  const a = splitsA[i];
                                  const b = splitsB[i];
                                  const bothPace = a?.pace && b?.pace;
                                  const bothHr   = a?.hr && b?.hr;

                                  // quem venceu o km (pace menor = mais rápido)
                                  const paceWinner = bothPace ? (a.pace < b.pace ? "A" : a.pace > b.pace ? "B" : "tie") : null;
                                  const hrWinner   = bothHr   ? (a.hr < b.hr ? "A" : a.hr > b.hr ? "B" : "tie") : null;

                                  // barra de pace: normaliza entre os dois
                                  // Barra proporcional à VANTAGEM relativa
                                  // 50% = empate, 100% = vencedor absoluto
                                  // Usamos sigmoid suavizado para não exagerar diferenças pequenas
                                  const advantage = (valA, valB, lowerIsBetter = true) => {
                                    if (!valA || !valB) return { pctA: 50, pctB: 50 };
                                    const diff = lowerIsBetter ? (valB - valA) : (valA - valB); // positivo = A venceu
                                    const avg  = (valA + valB) / 2;
                                    const rel  = diff / avg; // diferença relativa (-1 a 1)
                                    // mapeia para 20%–80% para não ser extremo demais
                                    const pctA = Math.min(80, Math.max(20, 50 + rel * 150));
                                    return { pctA: Math.round(pctA), pctB: Math.round(100 - pctA) };
                                  };

                                  const paceAdv = advantage(a?.pace, b?.pace, true);
                                  const hrAdv   = advantage(a?.hr,   b?.hr,   true);
                                  const velAdv  = advantage(a?.kmh,  b?.kmh,  false); // maior vel = melhor
                                  const velWinner = a?.kmh && b?.kmh ? (a.kmh > b.kmh ? "A" : a.kmh < b.kmh ? "B" : "tie") : null;

                                  return (
                                    <div key={i} style={{ background: "#0a1520", borderRadius: 10, padding: "14px 18px", border: "1px solid #1e3a4a" }}>
                                      {/* Cabeçalho do km */}
                                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                                        <div style={{ fontFamily: "'Bebas Neue'", fontSize: 20, color: "#64748b", letterSpacing: 2 }}>KM {i + 1}</div>
                                        {paceWinner && (
                                          <div style={{
                                            fontSize: 10, letterSpacing: 1, padding: "2px 10px", borderRadius: 20,
                                            background: paceWinner === "A" ? "#f9731622" : paceWinner === "B" ? "#22d3ee22" : "#ffffff11",
                                            color:      paceWinner === "A" ? "#f97316"   : paceWinner === "B" ? "#22d3ee"   : "#64748b",
                                            border: `1px solid ${paceWinner === "A" ? "#f9731644" : paceWinner === "B" ? "#22d3ee44" : "#ffffff22"}`,
                                          }}>
                                            {paceWinner === "tie" ? "EMPATE" : `${paceWinner === "A" ? compareA.name : compareB.name} MAIS RÁPIDO`}
                                          </div>
                                        )}
                                      </div>

                                      {/* Pace — barra proporcional à vantagem */}
                                      <div style={{ marginBottom: 10 }}>
                                        <div style={{ fontSize: 10, color: "#475569", letterSpacing: 1, marginBottom: 6 }}>PACE</div>
                                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                          <span style={{ fontFamily: "'Bebas Neue'", fontSize: 16, color: "#f97316", width: 44, textAlign: "right" }}>{pFmt(a?.pace)}</span>
                                          <div style={{ flex: 1, display: "flex", height: 10, borderRadius: 100, overflow: "hidden", gap: 2 }}>
                                            <div style={{ width: `${paceAdv.pctA}%`, background: bothPace ? (paceWinner === "A" ? "#f97316" : "#f9731644") : "#1e3a4a", borderRadius: "100px 0 0 100px", transition: "width 0.6s ease" }} />
                                            <div style={{ width: `${paceAdv.pctB}%`, background: bothPace ? (paceWinner === "B" ? "#22d3ee" : "#22d3ee44") : "#1e3a4a", borderRadius: "0 100px 100px 0", transition: "width 0.6s ease" }} />
                                          </div>
                                          <span style={{ fontFamily: "'Bebas Neue'", fontSize: 16, color: "#22d3ee", width: 44 }}>{pFmt(b?.pace)}</span>
                                        </div>
                                      </div>

                                      {/* FC — barra proporcional (menor FC = melhor) */}
                                      {(a?.hr || b?.hr) && (
                                        <div>
                                          <div style={{ fontSize: 10, color: "#475569", letterSpacing: 1, marginBottom: 6 }}>FC MÉDIA</div>
                                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                            <span style={{ fontFamily: "'Bebas Neue'", fontSize: 16, color: "#f97316", width: 44, textAlign: "right" }}>{a?.hr || "—"}</span>
                                            <div style={{ flex: 1, display: "flex", height: 10, borderRadius: 100, overflow: "hidden", gap: 2 }}>
                                              <div style={{ width: `${hrAdv.pctA}%`, background: bothHr ? (hrAdv.pctA > hrAdv.pctB ? "#f43f5e" : "#f43f5e44") : "#1e3a4a", borderRadius: "100px 0 0 100px", transition: "width 0.6s ease" }} />
                                              <div style={{ width: `${hrAdv.pctB}%`, background: bothHr ? (hrAdv.pctB > hrAdv.pctA ? "#a78bfa" : "#a78bfa44") : "#1e3a4a", borderRadius: "0 100px 100px 0", transition: "width 0.6s ease" }} />
                                            </div>
                                            <span style={{ fontFamily: "'Bebas Neue'", fontSize: 16, color: "#22d3ee", width: 44 }}>{b?.hr || "—"}</span>
                                          </div>
                                        </div>
                                      )}

                                      {/* Velocidade — barra proporcional (maior = melhor) */}
                                      {(a?.kmh || b?.kmh) && (
                                        <div style={{ marginTop: 8 }}>
                                          <div style={{ fontSize: 10, color: "#475569", letterSpacing: 1, marginBottom: 6 }}>VELOCIDADE</div>
                                          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                            <span style={{ fontFamily: "'Bebas Neue'", fontSize: 16, color: "#f97316", width: 44, textAlign: "right" }}>{a?.kmh ? `${a.kmh}` : "—"}</span>
                                            <div style={{ flex: 1, display: "flex", height: 10, borderRadius: 100, overflow: "hidden", gap: 2 }}>
                                              <div style={{ width: `${velAdv.pctA}%`, background: a?.kmh && b?.kmh ? (velWinner === "A" ? "#34d399" : "#34d39944") : "#1e3a4a", borderRadius: "100px 0 0 100px", transition: "width 0.6s ease" }} />
                                              <div style={{ width: `${velAdv.pctB}%`, background: a?.kmh && b?.kmh ? (velWinner === "B" ? "#34d399" : "#34d39944") : "#1e3a4a", borderRadius: "0 100px 100px 0", transition: "width 0.6s ease" }} />
                                            </div>
                                            <span style={{ fontFamily: "'Bebas Neue'", fontSize: 16, color: "#22d3ee", width: 44 }}>{b?.kmh ? `${b.kmh}` : "—"}</span>
                                          </div>
                                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#475569", marginTop: 2, paddingLeft: 54, paddingRight: 54 }}>
                                            <span>km/h</span><span>km/h</span>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ) : (
                            <div style={{ color: "#475569", fontSize: 12, textAlign: "center", padding: 32 }}>
                              Streams detalhados não disponíveis para estas corridas.
                            </div>
                          );
                        })()}
                      </>
                    )}
                  </>
                )}
              </div>
            )}

            {/* ── METAS ── */}
            {tab === "metas" && (
              <div className="fade-up">
                {/* Configuração de alertas */}
                <div style={{ background: "#0f1923", border: "1px solid #1e3a4a", borderRadius: 12, padding: 20, marginBottom: 24 }}>
                  <div style={{ fontSize: 11, letterSpacing: 2, color: "#64748b", marginBottom: 16 }}>⚙️ CONFIGURAR ALERTAS</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
                    {goals.map(g => (
                      <div key={g.id} style={{ background: "#0a1520", borderRadius: 8, padding: "12px 14px" }}>
                        <div style={{ fontSize: 10, color: "#475569", letterSpacing: 1, marginBottom: 8 }}>{g.label.toUpperCase()}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                          <span style={{ fontSize: 11, color: "#64748b" }}>Alertar em</span>
                          <input
                            type="number" min="10" max="99"
                            value={thresholds[g.id] ?? 80}
                            onChange={e => setThresholds(prev => ({ ...prev, [g.id]: Number(e.target.value) }))}
                            style={{ width: 48, background: "#0f1923", border: `1px solid ${g.color}55`, borderRadius: 4, color: g.color, padding: "2px 6px", fontSize: 13, fontFamily: "inherit", textAlign: "center" }}
                          />
                          <span style={{ fontSize: 11, color: "#64748b" }}>%</span>
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span style={{ fontSize: 11, color: "#64748b" }}>Meta</span>
                          {g.lowerIsBetter ? (
                            // Pace: input em formato mm:ss
                            <input
                              type="text" placeholder="6:00"
                              value={g.targetDisplay || "6:00"}
                              onChange={e => {
                                const val = e.target.value;
                                setGoals(prev => prev.map(x => {
                                  if (x.id !== g.id) return x;
                                  const parts = val.split(":");
                                  const decimal = parts.length === 2
                                    ? parseInt(parts[0]) + parseInt(parts[1] || 0) / 60
                                    : parseFloat(val) || x.target;
                                  return { ...x, target: decimal, targetDisplay: val };
                                }));
                              }}
                              style={{ width: 56, background: "#0f1923", border: `1px solid ${g.color}55`, borderRadius: 4, color: g.color, padding: "2px 6px", fontSize: 13, fontFamily: "inherit", textAlign: "center" }}
                            />
                          ) : (
                            <input
                              type="number" step="0.1" min="0"
                              value={g.target}
                              onChange={e => setGoals(prev => prev.map(x => x.id === g.id ? { ...x, target: parseFloat(e.target.value) || 0 } : x))}
                              style={{ width: 64, background: "#0f1923", border: `1px solid ${g.color}55`, borderRadius: 4, color: g.color, padding: "2px 6px", fontSize: 13, fontFamily: "inherit", textAlign: "center" }}
                            />
                          )}
                          <span style={{ fontSize: 11, color: "#64748b" }}>{g.unit}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Cards de metas */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 20, marginBottom: 24 }}>
                  {goals.map((g, i) => {
                    // pace: 100% quando current <= target (bateu a meta de ser mais rápido)
                    const pct = g.lowerIsBetter
                      ? Math.min(110, (g.target / (g.current || 1)) * 100)
                      : Math.min(100, (g.current / g.target) * 100);
                    const thr = thresholds[g.id] ?? 80;
                    const isAlert   = pct >= thr && pct < 100;
                    const isSuccess = pct >= 100;
                    const displayCurrent = g.display || g.current;
                    const displayTarget  = g.targetDisplay || g.target;
                    const remainingLabel = g.lowerIsBetter
                      ? (() => {
                          const diff = g.current - g.target; // positivo = ainda mais lento que a meta
                          if (diff <= 0) return "meta batida!";
                          const totalSecs = Math.round(diff * 60);
                          const m = Math.floor(totalSecs / 60);
                          const s = totalSecs % 60;
                          return `faltam melhorar ${m > 0 ? `${m}min ` : ""}${s}s no pace`;
                        })()
                      : `faltam ${Math.max(0, g.target - g.current).toFixed(1)} ${g.unit}`;
                    return (
                      <div key={i} style={{ background: "#0f1923", border: `1px solid ${isSuccess ? g.color : isAlert ? g.color + "66" : "#1e3a4a"}`, borderRadius: 12, padding: 24, position: "relative", overflow: "hidden" }}>
                        {isSuccess && <div style={{ position: "absolute", top: 12, right: 16, fontSize: 20 }}>🎯</div>}
                        {isAlert && !isSuccess && <div style={{ position: "absolute", top: 12, right: 16, fontSize: 20 }}>🔔</div>}
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                          <div style={{ fontSize: 13, color: "#94a3b8" }}>{g.label}</div>
                          <div style={{ fontSize: 11, color: "#475569" }}>
                            {displayCurrent} / {displayTarget} {g.unit}
                          </div>
                        </div>
                        <div style={{ background: "#0a1520", borderRadius: 100, height: 10, overflow: "visible", marginBottom: 12, position: "relative" }}>
                          <div style={{ width: `${Math.min(100, pct)}%`, background: `linear-gradient(90deg,${g.color}aa,${g.color})`, height: "100%", borderRadius: 100, transition: "width 1s ease" }} />
                          <div style={{ position: "absolute", top: -4, left: `${thr}%`, width: 2, height: 18, background: "#fbbf24", borderRadius: 2, transform: "translateX(-50%)" }} />
                          <div style={{ position: "absolute", top: -18, left: `${thr}%`, fontSize: 9, color: "#fbbf24", transform: "translateX(-50%)", whiteSpace: "nowrap" }}>{thr}%</div>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div style={{ fontSize: 36, fontFamily: "'Bebas Neue'", color: isSuccess ? g.color : isAlert ? g.color : "#64748b", letterSpacing: 2 }}>{Math.min(100, pct).toFixed(0)}%</div>
                          <div style={{ textAlign: "right" }}>
                            {isSuccess
                              ? <div style={{ fontSize: 12, color: g.color }}>Meta atingida! 🎉</div>
                              : <div style={{ fontSize: 11, color: "#475569" }}>{remainingLabel}</div>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div style={{ background: "#0f1923", border: "1px solid #1e3a4a", borderRadius: 12, padding: 24 }}>
                  <div style={{ fontSize: 11, letterSpacing: 2, color: "#64748b", marginBottom: 16 }}>KM POR SEMANA</div>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={weeklyData}>
                      <CartesianGrid stroke="#1e3a4a" strokeDasharray="3 3" />
                      <XAxis dataKey="week" tick={{ fill: "#475569", fontSize: 10 }} />
                      <YAxis tick={{ fill: "#475569", fontSize: 10 }} />
                      <Tooltip content={<CustomTooltip />} />
                      <Bar dataKey="km" fill="#f97316" radius={[4,4,0,0]} name="km" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* ── FREQUÊNCIA CARDÍACA ── */}
            {tab === "frequência" && (
              <div className="fade-up">
                <div style={{ fontSize: 11, letterSpacing: 2, color: "#64748b", marginBottom: 24 }}>ANÁLISE DE FREQUÊNCIA CARDÍACA</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 12, marginBottom: 24 }}>
                  {zoneData.map((z, i) => (
                    <div key={i} style={{ background: "#0f1923", border: `1px solid ${z.color}44`, borderTop: `3px solid ${z.color}`, borderRadius: 10, padding: "16px 14px" }}>
                      <div style={{ fontSize: 22, fontFamily: "'Bebas Neue'", color: z.color, letterSpacing: 2 }}>{z.zone}</div>
                      <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>{z.label}</div>
                      <div style={{ fontSize: 10, color: "#475569", marginBottom: 12 }}>{z.range}</div>
                      <div style={{ background: "#0a1520", borderRadius: 100, height: 6, overflow: "hidden" }}>
                        <div style={{ width: `${z.pct}%`, background: z.color, height: "100%", borderRadius: 100, transition: "width 1s ease" }} />
                      </div>
                      <div style={{ fontSize: 18, fontFamily: "'Bebas Neue'", color: z.color, marginTop: 8 }}>{z.pct}%</div>
                    </div>
                  ))}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 16 }}>
                  <div style={{ background: "#0f1923", border: "1px solid #1e3a4a", borderRadius: 12, padding: 24 }}>
                    <div style={{ fontSize: 11, letterSpacing: 2, color: "#64748b", marginBottom: 16 }}>FC MÉDIA POR CORRIDA</div>
                    <ResponsiveContainer width="100%" height={240}>
                      <LineChart data={runs.filter(r => r.avgHr).slice(-20).map(r => ({ name: fmtDate(r.date), hr: r.avgHr, max: r.maxHr }))}>
                        <CartesianGrid stroke="#1e3a4a" strokeDasharray="3 3" />
                        <XAxis dataKey="name" tick={{ fill: "#475569", fontSize: 9 }} />
                        <YAxis domain={["auto","auto"]} tick={{ fill: "#475569", fontSize: 10 }} />
                        <Tooltip content={<CustomTooltip />} />
                        <Line type="monotone" dataKey="hr"  stroke="#f43f5e" strokeWidth={2} dot={{ fill: "#f43f5e", r: 3 }} name="FC Média" />
                        <Line type="monotone" dataKey="max" stroke="#f9731655" strokeWidth={1.5} dot={false} name="FC Máx" strokeDasharray="4 2" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div style={{ background: "#0f1923", border: "1px solid #1e3a4a", borderRadius: 12, padding: 24 }}>
                    <div style={{ fontSize: 11, letterSpacing: 2, color: "#64748b", marginBottom: 16 }}>STATS CARDÍACOS</div>
                    <div style={{ display: "grid", gap: 10 }}>
                      {(() => {
                        const withHr = runs.filter(r => r.avgHr);
                        const avgHr  = withHr.length ? Math.round(withHr.reduce((a, r) => a + r.avgHr, 0) / withHr.length) : "—";
                        const maxHr  = withHr.length ? Math.max(...withHr.map(r => r.maxHr || 0)) : "—";
                        const zone   = hrZone(typeof avgHr === "number" ? avgHr : 0);
                        return [
                          { l: "FC Média (corridas)",  v: avgHr !== "—" ? `${avgHr} bpm` : "—", color: "#fbbf24" },
                          { l: "FC Máxima registrada", v: maxHr !== "—" ? `${maxHr} bpm` : "—", color: "#f43f5e" },
                          { l: "Zona predominante",    v: zone.label, color: zone.color },
                          { l: "Corridas com FC",      v: `${withHr.length} / ${runs.length}`, color: "#34d399" },
                        ].map((s, i) => (
                          <div key={i} style={{ background: "#0a1520", borderRadius: 8, padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <div style={{ fontSize: 11, color: "#64748b" }}>{s.l}</div>
                            <div style={{ fontSize: 16, fontFamily: "'Bebas Neue'", color: s.color, letterSpacing: 1 }}>{s.v}</div>
                          </div>
                        ));
                      })()}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

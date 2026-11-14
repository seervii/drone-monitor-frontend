import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession, NO_CONTROLS } from './useSession';

// Root: no role chosen yet -> Home, otherwise the workspace for that role.
export default function App() {
  const [role, setRole] = useState(null);
  if (!role) return <Home onPick={setRole} />;
  return <Workspace role={role} onBack={() => setRole(null)} />;
}

// PAGE 1: two tabs filling the whole screen.
function Home({ onPick }) {
  return (
    <div className="home">
      <button className="tab pilot" onClick={() => onPick('pilot')}>Pilot</button>
      <button className="tab robot" onClick={() => onPick('robot')}>Robot</button>
    </div>
  );
}

// Holds all connection state; switches between the list page and the session page.
function Workspace({ role, onBack }) {
  const s = useSession(role);
  return (
    <>
      {s.connState === 'idle'
        ? <PeerList role={role} s={s} onBack={onBack} />
        : <Session role={role} s={s} />}
      {s.incoming && <RequestPopup peer={s.incoming} onRespond={s.respond} />}
    </>
  );
}

// PAGE 2: pilots see available robots, robots see connected pilots.
function PeerList({ role, s, onBack }) {
  return (
    <div className="page">
      <button onClick={onBack}>Back</button>
      <h2>{role === 'pilot' ? 'Available robots' : 'Connected pilots'}</h2>
      <p className="muted">You are {s.me.name}</p>
      {s.peers.length === 0 && <p>None online yet.</p>}
      {s.peers.map((p) => (
        <div className="row" key={p.id}>
          <span>
            {p.name}
            <span className={'badge ' + (p.busy ? 'bad' : 'good')}>{p.busy ? 'Busy' : 'Online'}</span>
            {p.battery != null && <span className={'badge ' + batteryLevel(p.battery)}>{p.battery}%</span>}
          </span>
          <button disabled={p.busy} onClick={() => s.connect(p)}>Connect</button>
        </div>
      ))}
      <p>{s.status}</p>
    </div>
  );
}

// PAGE 3: live session over WebRTC. Video would go here later.
function Session({ role, s }) {
  const [text, setText] = useState('');
  const submit = () => {
    if (!text.trim()) return;
    s.send(text);
    setText('');
  };
  return (
    <div className="page">
      <h2>Session with {s.other?.name}</h2>
      <p>
        Connection: <b>{s.connState}</b>
        {s.latency && (
          <>
            {' '}| Latency: <span className={'badge ' + quality(s.latency.now)}>{s.latency.now} ms</span>
            <span className="muted"> avg {s.latency.avg} ms</span>
          </>
        )}
      </p>
      <Badges telemetry={s.telemetry} />
      {/* Pilot watches the robot's video; the robot sees its own camera preview */}
      <Video stream={role === 'pilot' ? s.remoteStream : s.localStream}
             label={role === 'pilot' ? 'Robot camera' : 'Your camera (sent to pilot)'} />
      {role === 'robot' && s.camError && <p className="muted">Camera unavailable: {s.camError}</p>}
      {/* Pilot sends commands; robot shows the commands it receives */}
      {role === 'pilot'
        ? <Controls onChange={s.sendControl} />
        : <ControlStatus controls={s.controls} />}
      <div className="log">
        {s.messages.map((m, i) => <div key={i}>{m.from}: {m.text}</div>)}
      </div>
      <div className="row">
        <input value={text} onChange={(e) => setText(e.target.value)}
               onKeyDown={(e) => e.key === 'Enter' && submit()}
               placeholder="Send a message over WebRTC" />
        <button onClick={submit}>Send</button>
        <button onClick={s.hangup}>Disconnect</button>
      </div>
    </div>
  );
}

// Shown to the OTHER side when someone requests a connection.
function RequestPopup({ peer, onRespond }) {
  return (
    <div className="overlay">
      <div className="modal">
        <p>{peer.name} wants to connect.</p>
        <button onClick={() => onRespond(true)}>Accept</button>
        <button onClick={() => onRespond(false)}>Reject</button>
      </div>
    </div>
  );
}

// Shows a MediaStream in a <video>. React has no srcObject prop, so it is set through a ref.
function Video({ stream, label }) {
  const ref = useRef(null);
  useEffect(() => { ref.current.srcObject = stream; }, [stream]); // attach or clear the stream
  return (
    <div className="video-box">
      <video ref={ref} autoPlay playsInline muted />
      {!stream && <span>Waiting for video...</span>}
      <small>{label}</small>
    </div>
  );
}

// Colour band for the latency badge: good under 50 ms, ok under 150 ms, otherwise bad.
function quality(ms) {
  if (ms < 50) return 'good';
  if (ms < 150) return 'ok';
  return 'bad';
}

// The four directions: name sent to the robot, arrow on the button, keyboard keys that trigger it.
const DIRS = [
  { name: 'forward', arrow: '\u2191', keys: ['w', 'arrowup'] },
  { name: 'left', arrow: '\u2190', keys: ['a', 'arrowleft'] },
  { name: 'back', arrow: '\u2193', keys: ['s', 'arrowdown'] },
  { name: 'right', arrow: '\u2192', keys: ['d', 'arrowright'] },
];

// Pilot: WASD / arrow keys or on-screen buttons. Sends the full pressed-state whenever it changes.
function Controls({ onChange }) {
  const [state, setState] = useState(NO_CONTROLS);
  // Turn one direction on or off (returns the same object if nothing changed, so no extra re-render).
  const set = useCallback((name, on) => setState((s) => (s[name] === on ? s : { ...s, [name]: on })), []);

  useEffect(() => { onChange(state); }, [state, onChange]);   // every change goes to the robot

  useEffect(() => {
    const find = (e) => DIRS.find((d) => d.keys.includes(e.key?.toLowerCase()));
    const down = (e) => {
      if (e.target instanceof HTMLInputElement) return;       // typing in the chat box: ignore
      const d = find(e);
      if (d) { e.preventDefault(); set(d.name, true); }
    };
    const up = (e) => { const d = find(e); if (d) set(d.name, false); };
    const release = () => setState(NO_CONTROLS);                // window lost focus: stop everything
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', release);
    };
  }, [set]);

  return (
    <div>
      <Pad state={state} set={set} />
      <p className="muted">Use W A S D or the arrow keys, or hold the buttons.</p>
    </div>
  );
}

// Robot: shows what the pilot is pressing.
function ControlStatus({ controls }) {
  const active = DIRS.filter((d) => controls[d.name]).map((d) => d.name);
  return (
    <div>
      <Pad state={controls} />
      <p className="muted">Pilot command: {active.length ? active.join(' + ') : 'stopped'}</p>
    </div>
  );
}

// Four direction buttons. With `set` they are interactive (pilot); without it they only show state (robot).
function Pad({ state, set }) {
  return (
    <div className="pad">
      {DIRS.map((d) => (
        <button
          key={d.name}
          className={`pad-btn ${d.name} ${state[d.name] ? 'on' : ''} ${set ? '' : 'readonly'}`}
          tabIndex={set ? 0 : -1}
          onPointerDown={set && (() => set(d.name, true))}
          onPointerUp={set && (() => set(d.name, false))}
          onPointerLeave={set && (() => set(d.name, false))}
          onPointerCancel={set && (() => set(d.name, false))}
        >
          {d.arrow}
        </button>
      ))}
    </div>
  );
}

// Colour band for a battery percentage.
function batteryLevel(v) {
  if (v > 50) return 'good';
  if (v > 20) return 'ok';
  return 'bad';
}

// One entry per badge. To show a new drone value, add a line here (key = field name in the telemetry reading).
const BADGES = [
  { key: 'battery', label: 'Battery', unit: '%', level: batteryLevel },
  { key: 'signal', label: 'Signal', unit: '%', level: (v) => (v > 60 ? 'good' : v > 30 ? 'ok' : 'bad') },
  { key: 'speed', label: 'Speed', unit: ' m/s' },
  { key: 'mode', label: 'Mode' },
];

// Current time, refreshed every `ms`, so we can notice when readings stop arriving.
function useNow(ms) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

// Live drone condition as badges. Greys out and warns if no reading arrived for 3 seconds.
function Badges({ telemetry }) {
  const now = useNow(1000);
  const stale = !telemetry || now - telemetry.at > 3000;
  return (
    <div className="badges">
      {BADGES.map((b) => {
        const v = telemetry?.data?.[b.key];
        const level = stale || v == null ? 'off' : b.level ? b.level(v) : '';
        return (
          <span key={b.key} className={`badge ${level}`}>
            {b.label}: {v == null ? '--' : v + (b.unit || '')}
          </span>
        );
      })}
      {stale && <span className="badge bad">{telemetry ? 'Telemetry lost' : 'No telemetry'}</span>}
    </div>
  );
}
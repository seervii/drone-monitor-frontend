// MOCK drone telemetry. The drone / backend dev replaces ONLY this file with the real feed.
//
// Contract the app relies on:
//   startTelemetry(getControls, onData)  ->  returns a stop() function
//   onData(reading) must be called whenever there is a new reading (about once per second is fine).
//   reading = { battery: 0-100, signal: 0-100, speed: m/s, mode: 'idle' | 'moving' | ... }
//   Extra keys are fine: add one line to BADGES in App.jsx to show them as a badge.
//   getControls() returns the pilot's current command { forward, back, left, right }.
//   The mock below uses it to fake movement; a real drone does not need it.

export function startTelemetry(getControls, onData) {
  let battery = 60 + Math.random() * 40;               // fake starting charge so every colour can be seen
  let speed = 0;                                        // fake speed in m/s

  const tick = () => {
    const c = getControls();                            // what the pilot is pressing right now
    const moving = c.forward || c.back || c.left || c.right;
    speed = moving ? Math.min(speed + 1, 5) : Math.max(speed - 1, 0); // speed up while moving, slow down when not
    battery = Math.max(0, battery - (moving ? 0.3 : 0.05));           // drains faster while moving
    onData({
      battery: Math.round(battery),
      signal: Math.round(80 + Math.random() * 15),      // fake signal strength
      speed,
      mode: moving ? 'moving' : 'idle',
    });
  };

  tick();                                               // first reading right away
  const id = setInterval(tick, 1000);                   // then once per second
  return () => clearInterval(id);                       // stop function
}
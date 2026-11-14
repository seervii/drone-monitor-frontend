# Drone Monitor Frontend

React + Vite frontend for pilot/robot connections over WebRTC.

## Run
```
npm install
npm run dev
```
Open http://localhost:5173 in two browser tabs: choose Pilot in one, Robot in the other.

## Flow
1. Choose Pilot or Robot.
2. Pilots see available robots, robots see connected pilots.
3. Clicking a peer sends a request; the other side accepts or rejects in a popup.
4. On accept, a WebRTC data channel opens (video tracks can be added in `src/useSession.js`).

## For the backend dev
`src/signaling.js` is a mock (BroadcastChannel). Replace it with a WebSocket client
that keeps the same three functions: `join`, `leave`, `send`. The contract is described at the top of that file.

## Live drone data (badges)
`src/telemetry.js` is a mock drone feed (battery, signal, speed, mode). Replace its body with the real feed and keep the
contract described at the top of the file. The robot page sends each reading to the pilot over the WebRTC data channel
(`{ type: 'telemetry', data }`) once per second, and the pilot page shows it as badges. To show another value, add a line
to `BADGES` in `src/App.jsx`. The robot's battery and busy/online state are also published through
`signaling.update(...)` so the peer list can show them before connecting.
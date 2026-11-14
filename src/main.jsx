import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// Mount the React app into <div id="root"> from index.html.
createRoot(document.getElementById('root')).render(<App />);

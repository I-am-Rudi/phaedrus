import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { loadBackend } from './backend';
import { AppProvider } from './state';

const { backend, events, mock } = await loadBackend();
const settings = await backend.settings.get();

createRoot(document.getElementById('root')!).render(
  <AppProvider backend={backend} events={events} mock={mock} initial={settings}>
    <App />
  </AppProvider>,
);

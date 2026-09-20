import { createRoot } from 'react-dom/client';
import { FirstRun } from './FirstRun';
import '@fontsource-variable/manrope';
import './style.css';

// The browser ticket belongs in memory only, never in subsequent links or requests.
const entry = new URL(location.href);
const fragment = new URLSearchParams(entry.hash.slice(1));
const accessTicket = fragment.get('access');
if (fragment.has('access')) { entry.hash = ''; history.replaceState(null, '', entry); }

createRoot(document.getElementById('root')!).render(<FirstRun accessTicket={accessTicket} />);

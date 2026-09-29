import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import App from './App';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        {/* Printed QR labels resolve here:
            /p/{panel}  Power  (existing labels keep working)
            /fa/{panel} Fire Alarm
            /lc/{panel} Lighting Control */}
        <Route path="/p/:slug" element={<App />} />
        <Route path="/fa/:slug" element={<App />} />
        <Route path="/lc/:slug" element={<App />} />
        <Route path="*" element={<App />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>
);

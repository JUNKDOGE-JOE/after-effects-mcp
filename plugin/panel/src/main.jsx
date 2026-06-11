import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { App } from './app/App';

const cs = new window.CSInterface();
createRoot(document.getElementById('root')).render(<App cs={cs} />);

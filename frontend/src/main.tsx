import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.tsx';
import QueryProvider from './components/QueryProvider';
import { BrowserRouter } from 'react-router-dom';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryProvider>
  </React.StrictMode>,
);

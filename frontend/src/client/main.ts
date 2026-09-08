/**
 * Entry point. Currently mounts the one page that exists; swap this for a
 * router when the rest of the frontend lands.
 */
import { mountKpiDashboard } from './kpi-dashboard.js';

const root = document.getElementById('app');
if (root) mountKpiDashboard(root);

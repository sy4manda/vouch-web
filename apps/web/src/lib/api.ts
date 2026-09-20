import { httpApi } from './httpApi';
import { mockApi } from './mockApi';

/** No VITE_API_URL -> the app runs entirely on the in-browser mock. */
export const DEMO_DATA = !import.meta.env.VITE_API_URL;
export const api = DEMO_DATA ? mockApi : httpApi;

/**
 * Assembles the API. Importing a route module registers its routes, so this
 * file is the single list of what the server exposes — adding a module here
 * is the only way an endpoint comes into existence.
 */
import { createHandler, routeTable } from './http.js';

import './routes/auth.js';
import './routes/practice.js';
import './routes/assignments.js';
import './routes/teacher.js';
import './routes/ratelimit.js';

export { routeTable };

export function createApp(options = {}) {
  return createHandler(options);
}

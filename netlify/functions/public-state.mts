import { getStore } from '@netlify/blobs';
import { publicApi } from '../../src/public-dashboard-api.js';

export default async request => publicApi({
  store: getStore({ name: 'yesp-public-dashboard', consistency: 'strong' }),
  secret: Netlify.env.get('YESP_SNAPSHOT_PUBLISH_TOKEN'),
})(request);

export const config = { path: ['/api/strategy-state', '/api/publish-state'] };

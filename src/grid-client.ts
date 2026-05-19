import axios from 'axios';
import https from 'node:https';

const DEFAULT_UTILITY_POWER_TIMEOUT_MS = 15000;
const ENLIGHTEN_BASE_URL = 'https://enlighten.enphaseenergy.com';

const GRID_AVAILABLE_VALUES = new Set([
  'closed',
  'grid_on',
  'grid-on',
  'grid_tied',
  'grid-tied',
  'on-grid',
  'on_grid',
  'multimode-ongrid',
  'multimode_ongrid'
]);

const GRID_OUTAGE_VALUES = new Set([
  'open',
  'grid_off',
  'grid-off',
  'grid_forming',
  'grid-forming',
  'off-grid',
  'off_grid',
  'multimode-offgrid',
  'multimode_offgrid',
  'islanded'
]);

export class EnphaseGridClient {
  [key: string]: any;

  constructor(log, config) {
    this.log = log;
    this.gatewayHost = config.gatewayHost || '';
    this.gatewaySerial = config.gatewaySerial || '';
    this.enlightenUser = config.enlightenUser || '';
    this.enlightenPasswd = config.enlightenPasswd || '';
    this.envoyToken = config.envoyToken || '';
    this.tokenExpiresAt = 0;
    this.timeoutMs = Number(config.utilityPowerTimeoutMs || DEFAULT_UTILITY_POWER_TIMEOUT_MS);
    this.httpsAgent = new https.Agent({ rejectUnauthorized: false });
  }

  updateConfig(config = {}) {
    if ((config as any).gatewaySerial) {
      this.gatewaySerial = (config as any).gatewaySerial;
    }
    if ((config as any).envoyToken) {
      this.envoyToken = (config as any).envoyToken;
      this.tokenExpiresAt = this.parseTokenExpiresAt(this.envoyToken, 0);
    }
  }

  async getUtilityPowerState() {
    if (!this.gatewayHost) {
      throw new Error('Missing gatewayHost for Utility Power local Envoy polling.');
    }

    const attempts = [
      {
        path: '/ivp/ensemble/relay',
        parser: (data) => this.parseRelayState(data)
      },
      {
        path: '/ivp/ensemble/inventory',
        parser: (data) => this.parseInventoryState(data)
      },
      {
        path: '/ivp/ensemble/status',
        parser: (data) => this.parseStatusState(data)
      }
    ];

    const errors = [];
    for (const attempt of attempts) {
      try {
        const data = await this.fetchJson(attempt.path);
        const parsed = attempt.parser(data);
        if (parsed) {
          return {
            ...parsed,
            endpoint: attempt.path
          };
        }

        errors.push(`${attempt.path}: no supported grid-state field found`);
      } catch (error) {
        if (this.isUnsupportedEndpointError(error)) {
          errors.push(`${attempt.path}: unsupported (${error.response?.status})`);
          continue;
        }

        throw error;
      }
    }

    return {
      available: null,
      source: 'unknown',
      rawState: '',
      gridMode: '',
      endpoint: '',
      detail: errors.join('; ')
    };
  }

  async fetchJson(path) {
    const headers: any = {
      Accept: 'application/json'
    };

    const token = await this.getEnvoyToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    let response;
    try {
      response = await axios.get(`${this.getGatewayBaseUrl()}${path}`, {
        headers,
        httpsAgent: this.httpsAgent,
        timeout: this.timeoutMs
      });
    } catch (error) {
      if (error?.response?.status !== 401 || !token) {
        throw this.describeHttpError(error, `Envoy local API ${path}`);
      }

      const refreshedToken = await this.refreshEnvoyToken();
      try {
        response = await axios.get(`${this.getGatewayBaseUrl()}${path}`, {
          headers: {
            ...headers,
            Authorization: `Bearer ${refreshedToken}`
          },
          httpsAgent: this.httpsAgent,
          timeout: this.timeoutMs
        });
      } catch (retryError) {
        throw this.describeHttpError(retryError, `Envoy local API ${path} after token refresh`);
      }
    }

    return response.data;
  }

  async getEnvoyToken() {
    if (this.envoyToken && !this.isEnvoyTokenExpired()) {
      return this.envoyToken;
    }

    if (!this.enlightenUser || !this.enlightenPasswd || !this.gatewaySerial) {
      return this.envoyToken || '';
    }

    return this.refreshEnvoyToken();
  }

  isEnvoyTokenExpired() {
    return this.tokenExpiresAt > 0 && Date.now() > (this.tokenExpiresAt - 60000);
  }

  async refreshEnvoyToken() {
    if (!this.enlightenUser || !this.enlightenPasswd || !this.gatewaySerial) {
      if (this.envoyToken) {
        return this.envoyToken;
      }

      throw new Error('Missing Enlighten username, password, or gateway serial for Envoy local API token.');
    }

    const loginForm = new URLSearchParams();
    loginForm.append('user[email]', this.enlightenUser);
    loginForm.append('user[password]', this.enlightenPasswd);

    let loginResponse;
    try {
      loginResponse = await axios.post(`${ENLIGHTEN_BASE_URL}/login/login.json`, loginForm, {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: this.timeoutMs
      });
    } catch (error) {
      throw this.describeHttpError(error, 'Enlighten login for Envoy token');
    }

    const cookies = loginResponse.headers['set-cookie'];
    if (!cookies?.length) {
      throw new Error('Enlighten login succeeded but no session cookie was returned for Envoy token request.');
    }

    let tokenResponse;
    try {
      tokenResponse = await axios.get(`${ENLIGHTEN_BASE_URL}/entrez-auth-token`, {
        params: {
          serial_num: this.gatewaySerial
        },
        headers: {
          Accept: 'application/json',
          Cookie: cookies.join('; ')
        },
        timeout: this.timeoutMs
      });
    } catch (error) {
      throw this.describeHttpError(
        error,
        `Enlighten Entrez auth token request for gateway serial ${this.maskSerial(this.gatewaySerial)}`
      );
    }

    const token = tokenResponse.data?.token;
    if (!token) {
      throw new Error('Entrez token response did not contain an Envoy token.');
    }

    this.envoyToken = token;
    this.tokenExpiresAt = this.parseTokenExpiresAt(token, tokenResponse.data?.expires_at);
    this.log.debug?.(`Received Envoy local API token expiring at ${this.tokenExpiresAt || 'unknown'}.`);
    return this.envoyToken;
  }

  parseTokenExpiresAt(token, fallbackExpiresAt) {
    const fallbackMilliseconds = Number(fallbackExpiresAt || 0);
    if (fallbackMilliseconds > 0) {
      return fallbackMilliseconds > 1000000000000
        ? fallbackMilliseconds
        : fallbackMilliseconds * 1000;
    }

    const [, payload] = String(token || '').split('.');
    if (!payload) {
      return 0;
    }

    try {
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return decoded.exp ? decoded.exp * 1000 : 0;
    } catch {
      return 0;
    }
  }

  describeHttpError(error, context) {
    const status = error?.response?.status;
    if (!status) {
      return error;
    }

    const body = this.summarizeResponseBody(error.response?.data);
    return new Error(`${context} failed with HTTP ${status}${body ? `: ${body}` : ''}`);
  }

  summarizeResponseBody(data) {
    if (data === undefined || data === null) {
      return '';
    }

    const text = typeof data === 'string' ? data : JSON.stringify(data);
    return text.length > 240 ? `${text.slice(0, 240)}...` : text;
  }

  maskSerial(serial) {
    const value = String(serial || '');
    if (value.length <= 4) {
      return value ? '****' : 'unknown';
    }

    return `${'*'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
  }

  getGatewayBaseUrl() {
    const host = String(this.gatewayHost || '').trim().replace(/\/+$/, '');
    if (/^https?:\/\//i.test(host)) {
      return host;
    }

    return `https://${host}`;
  }

  parseRelayState(data) {
    return this.normalizeGridState(data?.mains_admin_state, {
      source: 'ensemble-relay.mains_admin_state',
      gridMode: data?.Enpwr_grid_mode || data?.Enchg_grid_mode || data?.Solar_grid_mode || ''
    });
  }

  parseInventoryState(data) {
    if (!Array.isArray(data)) {
      return null;
    }

    const enpower = data
      .find((item) => String(item?.type || '').toUpperCase() === 'ENPOWER')
      ?.devices
      ?.find((device) => device?.mains_admin_state || device?.Enpwr_grid_mode);

    if (!enpower) {
      return null;
    }

    return this.normalizeGridState(enpower.mains_admin_state, {
      source: 'ensemble-inventory.ENPOWER.mains_admin_state',
      gridMode: enpower.Enpwr_grid_mode || ''
    });
  }

  parseStatusState(data) {
    const relayState = this.normalizeGridState(data?.relay?.mains_admin_state, {
      source: 'ensemble-status.relay.mains_admin_state',
      gridMode: data?.relay?.Enpwr_grid_mode || data?.relay?.Enchg_grid_mode || data?.relay?.Solar_grid_mode || ''
    });
    if (relayState) {
      return relayState;
    }

    const serialNumbers = data?.inventory?.serial_nums || {};
    for (const status of Object.values(serialNumbers)) {
      const gridMode = (status as any)?.reported_grid_mode;
      const parsed = this.normalizeGridState(gridMode, {
        source: 'ensemble-status.inventory.reported_grid_mode',
        gridMode
      });
      if (parsed) {
        return parsed;
      }
    }

    return null;
  }

  normalizeGridState(rawState, metadata = {}) {
    const normalized = String(rawState || '').trim().toLowerCase();
    if (!normalized) {
      return null;
    }

    if (GRID_AVAILABLE_VALUES.has(normalized)) {
      return {
        available: true,
        source: (metadata as any).source || 'unknown',
        rawState: normalized,
        gridMode: (metadata as any).gridMode || ''
      };
    }

    if (GRID_OUTAGE_VALUES.has(normalized)) {
      return {
        available: false,
        source: (metadata as any).source || 'unknown',
        rawState: normalized,
        gridMode: (metadata as any).gridMode || ''
      };
    }

    return null;
  }

  isUnsupportedEndpointError(error) {
    const status = error?.response?.status;
    return status === 404 || status === 405;
  }
}

import axios from 'axios';
import mqtt from 'mqtt';
import protobuf from 'protobufjs';

const ENLIGHTEN_BASE_URL = 'https://enlighten.enphaseenergy.com';
const ENTREZ_BASE_URL = 'https://entrez.enphaseenergy.com';
const DEFAULT_CHARGING_LEVEL = 48;
const DEFAULT_CONNECTOR_ID = 1;
const DEFAULT_STREAM_ENV = 'production';
const LIVESTREAM_PROTO_JSON = {
  nested: {
    google: {
      nested: {
        protobuf: {
          nested: {
            Timestamp: {
              fields: {
                seconds: { type: 'int64', id: 1 },
                nanos: { type: 'int32', id: 2 }
              }
            }
          }
        }
      }
    },
    DataMsg: {
      fields: {
        protocolVer: { type: 'int32', id: 1 },
        timestamp: { type: 'uint64', id: 2 },
        meters: { type: 'MeterSummaryData', id: 3 },
        battMode: { type: 'BattMode', id: 4 },
        backupSoc: { type: 'int32', id: 5 },
        dryContactRelayStatus: { rule: 'repeated', type: 'DryContactStatus', id: 6 },
        dryContactRelayName: { rule: 'repeated', type: 'DryContactName', id: 7 },
        loadStatus: { rule: 'repeated', type: 'LoadStatus', id: 8 },
        powerMatchStatus: { type: 'PowerMatchStatus', id: 9 }
      }
    },
    MeterSummaryData: {
      fields: {
        pv: { type: 'MeterChannel', id: 1 },
        storage: { type: 'MeterChannel', id: 2 },
        grid: { type: 'MeterChannel', id: 3 },
        load: { type: 'MeterChannel', id: 4 },
        gridRelay: { type: 'MeterSumGridState', id: 5 },
        soc: { type: 'int32', id: 6 },
        generator: { type: 'MeterChannel', id: 7 },
        genRelay: { type: 'MeterSumGridState', id: 8 },
        phaseCount: { type: 'uint32', id: 9 },
        isSplitPhase: { type: 'bool', id: 10 },
        gridToggleCheck: { type: 'GridToggleChannel', id: 14 }
      }
    },
    MeterChannel: {
      fields: {
        aggPMw: { type: 'int32', id: 1 },
        aggSMva: { type: 'int32', id: 2 },
        aggPPhMw: { rule: 'repeated', type: 'int32', id: 3 },
        aggSPhMva: { rule: 'repeated', type: 'int32', id: 4 }
      }
    },
    GridToggleChannel: {
      fields: {
        updateOngoing: { type: 'bool', id: 1 },
        gridOutageStatus: { type: 'bool', id: 2 },
        minEssentialStartTime: { type: 'int32', id: 3 },
        maxEssentialEndTime: { type: 'int32', id: 4 }
      }
    },
    DryContactStatus: {
      fields: {
        id: { type: 'DryContactId', id: 1 },
        state: { type: 'DryContactRelayState', id: 2 }
      }
    },
    DryContactName: {
      fields: {
        id: { type: 'DryContactId', id: 1 },
        loadName: { type: 'string', id: 2 }
      }
    },
    LoadStatus: {
      fields: {
        id: { type: 'string', id: 1 },
        relayStatus: { type: 'string', id: 2 },
        power: { type: 'float', id: 3 }
      }
    },
    PowerMatchStatus: {
      fields: {
        status: { type: 'bool', id: 1 },
        totalPCUCount: { type: 'uint32', id: 2 },
        runningPCUCount: { type: 'uint32', id: 3 },
        isSupported: { type: 'bool', id: 4 }
      }
    },
    MeterSumGridState: {
      values: {
        OPER_RELAY_UNKNOWN: 0,
        OPER_RELAY_OPEN: 1,
        OPER_RELAY_CLOSED: 2,
        OPER_RELAY_OFFGRID_AC_GRID_PRESENT: 3,
        OPER_RELAY_OFFGRID_READY_FOR_RESYNC_CMD: 4,
        OPER_RELAY_WAITING_TO_INITIALIZE_ON_GRID: 5,
        OPER_RELAY_GEN_OPEN: 6,
        OPER_RELAY_GEN_CLOSED: 7,
        OPER_RELAY_GEN_STARTUP: 8,
        OPER_RELAY_GEN_SYNC_READY: 9,
        OPER_RELAY_GEN_AC_STABLE: 10,
        OPER_RELAY_GEN_AC_UNSTABLE: 11
      }
    },
    BattMode: {
      values: {
        BATT_MODE_FULL_BACKUP: 0,
        BATT_MODE_SELF_CONS: 1,
        BATT_MODE_SAVINGS: 2,
        BATT_MODE_UNKNOWN: -1
      }
    },
    DryContactId: {
      values: {
        NC1: 0,
        NC2: 1,
        NO1: 2,
        NO2: 3
      }
    },
    DryContactRelayState: {
      values: {
        DC_RELAY_STATE_INVALID: 0,
        DC_RELAY_OFF: 1,
        DC_RELAY_ON: 2
      }
    }
  }
};

export class EnphaseChargerClient {
  constructor(log, config) {
    this.log = log;
    this.config = config;
    this.systemId = config.systemId;
    this.chargerSerial = config.chargerSerial;
    this.gatewaySerial = config.gatewaySerial;
    this.gatewayHost = config.gatewayHost;
    this.enlightenUser = config.enlightenUser;
    this.enlightenPasswd = config.enlightenPasswd;
    this.configManufacturer = config.manufacturer || 'Enphase';
    this.configModel = config.model || '';
    this.configFirmwareRevision = config.chargerFirmware || '';
    this.apiMode = config.apiMode || 'stub';
    this.authMode = config.authMode || 'gateway-token';
    this.chargingLevel = Number.isFinite(config.chargingLevel) ? config.chargingLevel : DEFAULT_CHARGING_LEVEL;
    this.connectorId = Number.isFinite(config.connectorId) ? config.connectorId : DEFAULT_CONNECTOR_ID;
    this.stateRequest = config.stateRequest || {};
    this.controlRequest = config.controlRequest || {};
    this.onLivePowerUpdate = typeof config.onLivePowerUpdate === 'function'
      ? config.onLivePowerUpdate
      : null;
    this.accessToken = config.envoyToken || '';
    this.tokenExpiresAt = 0;
    this.enlightenCookieHeader = '';
    this.enlightenSessionId = '';
    this.evseDeviceCount = 1;
    this.summaryData = null;
    this.selectedChargerSummary = null;
    this.summaryFirmwareVersion = '';
    this.summaryModelName = '';
    this.summarySku = '';
    this.summaryPartNumber = '';
    this.summaryRatedCurrent = 0;
    this.summaryChargeLevelMax = 0;
    this.latestStreamSampleAt = 0;
    this.latestLivePowerWatts = 0;
    this.lastPublishedLivePowerWatts = null;
    this.lastLoggedPowerWatts = null;
    this.lastLoggedPowerSource = '';
    this.latestSiteLoadWatts = null;
    this.lastKnownNonChargingLoadWatts = null;
    this.lastKnownNonChargingLoadAt = 0;
    this.sessionBaselineLoadWatts = null;
    this.sessionBaselineObservedWatts = null;
    this.sessionEstimatedPowerWatts = 0;
    this.chargingSessionArmed = false;
    this.waitingForBaselineLogSent = false;
    const livestreamRoot = protobuf.Root.fromJSON(LIVESTREAM_PROTO_JSON);
    this.dataMsgType = livestreamRoot.lookupType('DataMsg');
    this.mqttClient = null;
    this.mqttConnectPromise = null;
    this.mqttTopic = '';
    this.streamEnv = config.streamEnv || DEFAULT_STREAM_ENV;
    this.commandedState = null;
    this.commandedStateUntil = 0;
    this.mockState = {
      enabled: Boolean(config.mockEnabled),
      active: Boolean(config.mockActive),
      powerWatts: Number.isFinite(config.mockPowerWatts) ? config.mockPowerWatts : 0,
      sessionState: config.mockSessionState || 'idle'
    };
  }

  async authenticate() {
    if (this.apiMode === 'mock') {
      return 'mock-token';
    }

    if (this.apiMode === 'enlighten-web') {
      return this.authenticateEnlightenWebSession();
    }

    if (this.authMode === 'none') {
      return '';
    }

    if (this.accessToken) {
      return this.accessToken;
    }

    if (!this.enlightenUser || !this.enlightenPasswd || !this.gatewaySerial) {
      throw new Error('Missing credentials or gateway serial for Enphase authentication.');
    }

    const loginForm = new URLSearchParams();
    loginForm.append('user[email]', this.enlightenUser);
    loginForm.append('user[password]', this.enlightenPasswd);

    const loginResponse = await axios.post(`${ENLIGHTEN_BASE_URL}/login/login.json`, loginForm, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 30000
    });

    const cookies = loginResponse.headers['set-cookie'];
    if (!cookies?.length) {
      throw new Error('Enlighten login succeeded but no session cookie was returned.');
    }

    const tokenResponse = await axios.post(`${ENTREZ_BASE_URL}/tokens`, {
      serial_num: this.gatewaySerial
    }, {
      headers: {
        Accept: 'application/json',
        Cookie: cookies.join('; ')
      },
      timeout: 30000
    });

    const token = tokenResponse.data?.token;
    if (!token) {
      throw new Error('Entrez token response did not contain a token.');
    }

    this.accessToken = token;
    this.tokenExpiresAt = tokenResponse.data?.expires_at ?? 0;
    this.log.debug?.(`Received Enphase token expiring at ${this.tokenExpiresAt || 'unknown'}.`);
    return this.accessToken;
  }

  async authenticateEnlightenWebSession(forceRefresh = false) {
    if (!forceRefresh && this.enlightenCookieHeader && this.enlightenSessionId) {
      return this.enlightenSessionId;
    }

    if (!this.enlightenUser || !this.enlightenPasswd) {
      throw new Error('Missing Enlighten username or password for web session authentication.');
    }

    const loginForm = new URLSearchParams();
    loginForm.append('user[email]', this.enlightenUser);
    loginForm.append('user[password]', this.enlightenPasswd);

    const loginResponse = await axios.post(`${ENLIGHTEN_BASE_URL}/login/login.json`, loginForm, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 30000
    });

    const cookies = loginResponse.headers['set-cookie'];
    if (!cookies?.length) {
      throw new Error('Enlighten login succeeded but no web session cookies were returned.');
    }

    const cookieMap = this.parseSetCookies(cookies);
    this.enlightenSessionId = cookieMap._enlighten_4_session || '';
    this.enlightenCookieHeader = this.formatCookieHeader(cookieMap);

    if (!this.enlightenSessionId) {
      throw new Error('Unable to find _enlighten_4_session cookie after Enlighten login.');
    }

    this.log.debug?.('Authenticated to Enlighten web session successfully.');
    return this.enlightenSessionId;
  }

  async getChargerState() {
    await this.authenticate();

    if (this.apiMode === 'mock') {
      return { ...this.mockState };
    }

    if (this.apiMode === 'enlighten-web') {
      return this.getStateViaEnlightenWeb();
    }

    if (this.apiMode === 'rest') {
      return this.getStateViaRest();
    }

    throw new Error(
      'Charger state API not discovered yet. Next step: map the Enphase cloud or AWS IoT endpoints for charger status.'
    );
  }

  async setChargingEnabled(enabled) {
    await this.authenticate();

    if (this.apiMode === 'mock') {
      this.mockState.enabled = Boolean(enabled);
      this.mockState.active = Boolean(enabled) && this.mockState.powerWatts > 0;
      this.mockState.sessionState = enabled ? 'charging-enabled' : 'disabled';
      return { ...this.mockState };
    }

    if (this.apiMode === 'enlighten-web') {
      return this.setChargingEnabledViaEnlightenWeb(Boolean(enabled));
    }

    if (this.apiMode === 'rest') {
      return this.setChargingEnabledViaRest(Boolean(enabled));
    }

    throw new Error(
      'Charger control API not discovered yet. Next step: map the Enphase cloud or AWS IoT control endpoint for enable/disable.'
    );
  }

  async getStateViaEnlightenWeb() {
    await this.ensureDiscoveredIdentifiers();

    const response = await axios.get(
      `${ENLIGHTEN_BASE_URL}/service/evse_controller/${this.systemId}/ev_chargers/status`,
      {
        headers: this.buildEnlightenWebHeaders({
          Accept: '*/*',
          'Content-Type': 'application/json'
        }),
        timeout: 30000
      }
    );

    const charger = response.data?.data?.chargers?.find((entry) => entry?.sn === this.chargerSerial);
    if (!charger) {
      throw new Error(`Charger ${this.chargerSerial} was not present in Enlighten status response.`);
    }

    const connector = Array.isArray(charger.connectors) ? charger.connectors[0] : undefined;
    const charging = Boolean(charger.charging);
    const pluggedIn = Boolean(charger.pluggedIn);
    const sessionState = this.describeSessionState(charger, connector);
    const powerWatts = charging ? this.getRecentLivePowerWatts() : 0;

    if (!charging) {
      this.stopEvseLiveStream();
      this.resetEstimatedChargingSession();
      this.latestLivePowerWatts = 0;
      this.latestStreamSampleAt = 0;
    }
    let state = {
      enabled: charging,
      active: charging,
      powerWatts,
      sessionState: sessionState || (pluggedIn ? 'plugged-in' : 'idle')
    };

    state = this.applyCommandedStateOverride(state);

    this.log.debug?.(`Enlighten charger state payload: ${JSON.stringify(charger, null, 2)}`);

    return state;
  }

  async setChargingEnabledViaEnlightenWeb(enabled) {
    await this.ensureDiscoveredIdentifiers();

    if (enabled) {
      await this.preparePreChargeBaseline();
    }

    const url = enabled
      ? `${ENLIGHTEN_BASE_URL}/service/evse_controller/${this.systemId}/ev_chargers/${this.chargerSerial}/start_charging`
      : `${ENLIGHTEN_BASE_URL}/service/evse_controller/${this.systemId}/ev_chargers/${this.chargerSerial}/stop_charging`;
    const method = enabled ? 'post' : 'put';
    const data = enabled
      ? { chargingLevel: this.getResolvedChargingLevel(), connectorId: this.connectorId }
      : null;

    const response = await axios({
      method,
      url,
      data,
      timeout: 30000,
      validateStatus: () => true,
      headers: this.buildEnlightenWebHeaders({
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'Content-Type': 'application/json'
      })
    });

    if (response.status >= 400) {
      this.log.warn?.(`Enlighten web control ${method.toUpperCase()} ${url} -> ${response.status} ${JSON.stringify(response.data)}`);
      const alreadyInRequestedState = enabled
        ? response.data?.error?.additionalInfo === 'Charger is already in charging state'
        : response.data?.error?.additionalInfo === 'Charger is already in stopped state';
      if (!alreadyInRequestedState) {
        throw new Error(
          `Enlighten web control failed: ${method.toUpperCase()} ${url} -> ${response.status} ${JSON.stringify(response.data)}`
        );
      }
    } else {
      this.log.info?.(`Enlighten web control ${method.toUpperCase()} ${url} -> ${response.status}`);
      this.log.debug?.(`Enlighten web control payload: ${JSON.stringify(response.data, null, 2)}`);
    }

    return this.refreshStateAfterControl(enabled, method, url);
  }

  async refreshStateAfterControl(enabled, method, url) {
    this.setCommandedState(enabled);
    if (enabled) {
      void this.ensureEvseLiveStream(false).catch((error) => {
        this.log.warn?.(
          `Unable to start EVSE livestream after successful ${method.toUpperCase()} ${url}: ${error.message || error}`
        );
      });
    } else {
      this.stopEvseLiveStream();
    }
    return this.getCommandedStateFallback(enabled);
  }

  async preparePreChargeBaseline() {
    const maxBaselineAgeMs = 5 * 60 * 1000;
    if (
      Number.isFinite(this.lastKnownNonChargingLoadWatts)
      && this.lastKnownNonChargingLoadAt
      && (Date.now() - this.lastKnownNonChargingLoadAt) < maxBaselineAgeMs
    ) {
      this.log.info?.(
        `Using recent non-charging site load ${Math.round(this.lastKnownNonChargingLoadWatts)} W as pre-charge baseline.`
      );
      return;
    }

    const previousBaselineAt = this.lastKnownNonChargingLoadAt;
    await this.ensureEvseLiveStream(false);
    const deadline = Date.now() + 8000;

    while (Date.now() < deadline) {
      if (
        Number.isFinite(this.lastKnownNonChargingLoadWatts)
        && this.lastKnownNonChargingLoadAt > previousBaselineAt
      ) {
        this.log.info?.(
          `Captured pre-charge baseline ${Math.round(this.lastKnownNonChargingLoadWatts)} W from short livestream warmup.`
        );
        return;
      }

      await this.sleep(250);
    }

    this.log.info?.('Proceeding without a fresh pre-charge baseline; will fall back to early-session estimation.');
  }

  async ensureEvseLiveStream(forceRefresh = false) {
    if (this.apiMode !== 'enlighten-web') {
      this.log.info?.(`Skipping EVSE livestream because apiMode is ${this.apiMode}.`);
      return;
    }

    await this.ensureDiscoveredIdentifiers(forceRefresh);

    if (this.mqttConnectPromise && !forceRefresh) {
      await this.mqttConnectPromise;
      return;
    }

    if (this.mqttClient && !forceRefresh) {
      if (!this.mqttClient.connected) {
        this.stopEvseLiveStream();
      } else {
        return;
      }
    }

    if (this.mqttClient && !forceRefresh) {
      return;
    }

    this.mqttConnectPromise = this.connectEvseLiveStream(forceRefresh)
      .catch((error) => {
        this.log.warn(`EVSE livestream setup failed: ${error.message || error}`);
      })
      .finally(() => {
        this.mqttConnectPromise = null;
      });

    await this.mqttConnectPromise;
  }

  async connectEvseLiveStream(forceRefresh = false) {
    await this.authenticateEnlightenWebSession(forceRefresh);
    await this.ensureDiscoveredIdentifiers(forceRefresh);

    if (!this.gatewaySerial) {
      throw new Error('gatewaySerial is required for EVSE livestream power monitoring.');
    }

    const [streamResponse, authResponse] = await Promise.all([
      axios.get(
        `${ENLIGHTEN_BASE_URL}/service/evse_controller/${this.systemId}/ev_chargers/start_live_stream`,
        {
          headers: this.buildEnlightenWebHeaders({
            Accept: 'application/json, text/javascript, */*; q=0.01'
          }),
          timeout: 30000
        }
      ),
      axios.get(`${ENLIGHTEN_BASE_URL}/pv/aws_sigv4/livestream.json?serial_num=${this.gatewaySerial}`, {
        headers: {
          Cookie: this.enlightenCookieHeader,
          Accept: 'application/json'
        },
        timeout: 30000
      })
    ]);

    const liveStreamTopicList = streamResponse.data?.data?.liveStreamTopicList;
    const authPayload = authResponse.data || {};
    if (!Array.isArray(liveStreamTopicList) || !liveStreamTopicList.length) {
      throw new Error('EVSE livestream response did not include any topics.');
    }

    this.log.info?.(`EVSE livestream topics: ${JSON.stringify(liveStreamTopicList)}`);

    const mqttEndpoint = authPayload.aws_iot_endpoint;
    const authorizer = authPayload.aws_authorizer;
    const tokenKey = authPayload.aws_token_key;
    const tokenValue = authPayload.aws_token_value;
    const digest = authPayload.aws_digest;

    if (!mqttEndpoint || !authorizer || !tokenKey || !tokenValue || !digest) {
      throw new Error('AWS livestream auth payload was missing required connection fields.');
    }

    const authorizerQuery = [
      `x-amz-customauthorizer-name=${authorizer}`,
      `${tokenKey}=${tokenValue}`,
      `site-id=${this.systemId}`,
      `x-amz-customauthorizer-signature=${encodeURIComponent(digest)}`,
      `evse-count=${this.evseDeviceCount || 1}`,
      `env=${this.streamEnv}`
    ].join('&');

    const topics = [...new Set(liveStreamTopicList.filter((topicValue) => typeof topicValue === 'string' && topicValue))];
    const topic = topics[0];
    const wildcardTopics = [...new Set([
      ...topics,
      'v1/live-stream/#',
      'v1/evse/prod/live-stream/#'
    ])];
    const brokerUrl = `wss://${mqttEndpoint}/mqtt?${authorizerQuery}`;

    if (this.mqttClient) {
      this.stopEvseLiveStream();
    }

    this.mqttTopic = topic;
    this.log.debug?.(`Connecting to EVSE livestream topics ${JSON.stringify(wildcardTopics)} via ${brokerUrl}`);

    const client = mqtt.connect(brokerUrl, {
      protocol: 'wss',
      username: authorizerQuery,
      reconnectPeriod: 5000,
      connectTimeout: 30000,
      clientId: `hb-enphase-ev-${Date.now()}`,
      protocolVersion: 4,
      clean: true,
      wsOptions: {
        origin: ENLIGHTEN_BASE_URL,
        headers: {
          Origin: ENLIGHTEN_BASE_URL,
          Referer: `${ENLIGHTEN_BASE_URL}/mobile/${this.systemId}/external/live-status`
        }
      }
    });

    this.mqttClient = client;

    let mqttReady = false;

    await new Promise((resolve, reject) => {
      let settled = false;
      const timeoutHandle = setTimeout(() => {
        cleanup();
        this.stopEvseLiveStream(client);
        if (!settled) {
          settled = true;
          reject(new Error('Timed out waiting for EVSE livestream MQTT connection.'));
        }
      }, 15000);

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        client.off('connect', onConnect);
        client.off('error', onError);
        client.off('close', onCloseBeforeConnect);
      };

      const onConnect = () => {
        this.log.debug?.('EVSE livestream MQTT connection established.');
        client.subscribe(wildcardTopics, (error) => {
          cleanup();
          if (error) {
            if (!settled) {
              settled = true;
              reject(error);
            }
            return;
          }

          this.log.debug?.(`Subscribed to EVSE livestream topics ${JSON.stringify(wildcardTopics)}.`);
          mqttReady = true;
          if (!settled) {
            settled = true;
            resolve();
          }
        });
      };

      const onError = (error) => {
        if (!settled) {
          settled = true;
          cleanup();
          reject(error);
        }
      };

      const onCloseBeforeConnect = () => {
        if (!settled) {
          settled = true;
          cleanup();
          this.stopEvseLiveStream(client);
          reject(new Error('EVSE livestream socket closed before MQTT connect.'));
        }
      };

      client.once('connect', onConnect);
      client.once('error', onError);
      client.once('close', onCloseBeforeConnect);
    });

    client.on('message', (messageTopic, payloadBuffer) => {
      try {
        let powerWatts = null;
        let powerSource = '';

        const jsonPayload = this.tryParseJsonPayload(payloadBuffer);
        if (jsonPayload) {
          const normalized = this.normalizeEvseLivePayload(jsonPayload);
          if (normalized) {
            powerWatts = typeof normalized.power_W === 'number' ? normalized.power_W : null;
            if (Number.isFinite(powerWatts)) {
              powerSource = 'evse-json';
            }
            this.log.debug?.(`EVSE livestream sample ${JSON.stringify(normalized)}`);
          }
        }

        const dataMsgPayload = this.tryDecodeDataMsgPayload(payloadBuffer);
        if (dataMsgPayload) {
          const dataMsgSummary = this.summarizeDataMsgPayload(dataMsgPayload);
          const estimatedPowerWatts = this.updateEstimatedPowerFromDataMsg(dataMsgSummary);
          if (Number.isFinite(estimatedPowerWatts)) {
            powerWatts = estimatedPowerWatts;
            if (!powerSource) {
              powerSource = 'estimated-site-delta';
            }
          }
        }

        if (Number.isFinite(powerWatts)) {
          this.latestStreamSampleAt = Date.now();
          this.latestLivePowerWatts = powerWatts;
          this.publishLivePowerUpdate(this.latestLivePowerWatts);
          if (powerSource && this.shouldLogPowerSource(powerSource, powerWatts)) {
            this.log.info?.(`EVSE live power ${Math.round(powerWatts)} W via ${powerSource}`);
          }
        }
      } catch (error) {
        this.log.debug?.(`Unable to parse EVSE livestream payload: ${error.message || error}`);
      }
    });

    client.on('error', (error) => {
      this.log.warn(`EVSE livestream client error (${mqttEndpoint}): ${error.message || error}`);
      if (!mqttReady) {
        this.stopEvseLiveStream(client);
      }
    });

    client.on('close', () => {
      if (!mqttReady) {
        this.log.warn?.(`EVSE livestream connection closed before becoming usable (${mqttEndpoint}).`);
        this.stopEvseLiveStream(client);
        return;
      }

      this.log.debug?.(`EVSE livestream connection closed; waiting for MQTT reconnect (${mqttEndpoint}).`);
    });
  }

  stopEvseLiveStream(clientToStop = this.mqttClient) {
    if (!clientToStop) {
      return;
    }

    try {
      clientToStop.end(true);
    } catch (error) {
      this.log.debug?.(`Unable to close EVSE livestream client cleanly: ${error.message || error}`);
    }

    if (clientToStop === this.mqttClient) {
      this.mqttClient = null;
      this.mqttTopic = '';
    }
  }

  async ensureDiscoveredIdentifiers(forceRefresh = false) {
    if (!this.systemId) {
      throw new Error('systemId is required for enlighten-web mode.');
    }

    if (this.chargerSerial && this.gatewaySerial && !forceRefresh) {
      return;
    }

    await this.fetchChargerSummary(forceRefresh);
  }

  async fetchChargerSummary(forceRefresh = false) {
    if (this.summaryData && !forceRefresh) {
      return this.summaryData;
    }

    await this.authenticateEnlightenWebSession(forceRefresh);

    const response = await axios.get(
      `${ENLIGHTEN_BASE_URL}/service/evse_controller/api/v2/${this.systemId}/ev_chargers/summary?filter_retired=true`,
      {
        headers: this.buildEnlightenWebHeaders({
          Accept: 'application/json, text/javascript, */*; q=0.01'
        }),
        timeout: 30000
      }
    );

    const chargers = Array.isArray(response.data?.data) ? response.data.data : [];
    if (!chargers.length) {
      throw new Error(`No EV chargers were found in summary response for system ${this.systemId}.`);
    }

    this.summaryData = chargers;
    this.evseDeviceCount = chargers.length;

    if (!this.chargerSerial) {
      if (chargers.length > 1) {
        this.log.warn(
          `Multiple EV chargers were found for system ${this.systemId}; defaulting to the first one (${chargers[0]?.serialNumber}).`
        );
      }
      this.chargerSerial = chargers[0]?.serialNumber || this.chargerSerial;
    }

    const selectedCharger = chargers.find((entry) => entry?.serialNumber === this.chargerSerial) || chargers[0];
    if (!selectedCharger) {
      throw new Error(`Unable to resolve charger summary for charger ${this.chargerSerial || 'unknown'}.`);
    }

    this.selectedChargerSummary = selectedCharger;
    this.chargerSerial = selectedCharger.serialNumber || this.chargerSerial;
    this.summaryFirmwareVersion = selectedCharger.firmwareVersion || this.summaryFirmwareVersion;
    this.summaryModelName = selectedCharger.modelName || this.summaryModelName;
    this.summarySku = selectedCharger.sku || this.summarySku;
    this.summaryPartNumber = selectedCharger.partNumber || this.summaryPartNumber;
    this.summaryRatedCurrent = this.parseFiniteNumber(selectedCharger.ratedCurrent, this.summaryRatedCurrent);
    this.summaryChargeLevelMax = this.parseFiniteNumber(
      selectedCharger.chargeLevelDetails?.max,
      this.summaryChargeLevelMax
    );

    if (!this.gatewaySerial) {
      this.gatewaySerial = selectedCharger.gatewayConnectivityDetails?.[0]?.gwSerialNum || this.gatewaySerial;
    }

    this.log.debug?.(
      `Resolved chargerSerial=${this.chargerSerial || 'unknown'} gatewaySerial=${this.gatewaySerial || 'unknown'}`
    );

    return chargers;
  }

  async getStateViaRest() {
    const requestConfig = this.buildRequestConfig(this.stateRequest, null);
    const response = await axios(requestConfig);
    const payload = response.data;

    this.log.info?.(`State request ${requestConfig.method?.toUpperCase()} ${requestConfig.url} -> ${response.status}`);
    this.log.debug?.(`State response payload: ${JSON.stringify(payload, null, 2)}`);

    return {
      enabled: this.readMappedValue(payload, this.stateRequest.enabledPath, false),
      active: this.readMappedValue(payload, this.stateRequest.activePath, false),
      powerWatts: this.readMappedValue(payload, this.stateRequest.powerPath, 0),
      sessionState: this.readMappedValue(payload, this.stateRequest.sessionStatePath, 'unknown')
    };
  }

  async setChargingEnabledViaRest(enabled) {
    const requestConfig = this.buildRequestConfig(this.controlRequest, enabled);
    const response = await axios(requestConfig);
    const payload = response.data;

    this.log.info?.(`Control request ${requestConfig.method?.toUpperCase()} ${requestConfig.url} -> ${response.status}`);
    this.log.debug?.(`Control response payload: ${JSON.stringify(payload, null, 2)}`);

    if (!this.stateRequest.url) {
      return {
        enabled,
        active: enabled,
        powerWatts: enabled ? this.mockState.powerWatts : 0,
        sessionState: enabled ? 'enabled' : 'disabled'
      };
    }

    return this.getStateViaRest();
  }

  buildRequestConfig(definition, enabled) {
    const method = (definition.method || 'get').toLowerCase();
    const headers = {
      Accept: 'application/json',
      ...this.parseJsonObject(definition.headers, 'request headers')
    };

    if (this.authMode === 'gateway-token' && this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }

    const config = {
      method,
      timeout: 30000,
      validateStatus: () => true,
      headers,
      url: this.interpolateTemplate(definition.url || '', enabled)
    };

    const body = this.interpolateMaybeJson(definition.body, enabled);
    if (body !== undefined && method !== 'get') {
      config.data = body;
    }

    return config;
  }

  buildEnlightenWebHeaders(extraHeaders = {}) {
    return {
      Origin: ENLIGHTEN_BASE_URL,
      Referer: `${ENLIGHTEN_BASE_URL}/mobile/${this.systemId}/external/live-status`,
      'X-Requested-With': 'XMLHttpRequest',
      'e-auth-token': this.enlightenSessionId,
      Cookie: this.enlightenCookieHeader,
      ...extraHeaders
    };
  }

  interpolateMaybeJson(value, enabled) {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    if (typeof value !== 'string') {
      return value;
    }

    const interpolated = this.interpolateTemplate(value, enabled);
    try {
      return JSON.parse(interpolated);
    } catch {
      return interpolated;
    }
  }

  interpolateTemplate(value, enabled) {
    return String(value)
      .replaceAll('{{enabled}}', String(Boolean(enabled)))
      .replaceAll('{{gatewaySerial}}', this.gatewaySerial || '')
      .replaceAll('{{gatewayHost}}', this.gatewayHost || '');
  }

  parseJsonObject(value, label) {
    if (!value) {
      return {};
    }

    if (typeof value === 'object') {
      return value;
    }

    try {
      return JSON.parse(value);
    } catch (error) {
      throw new Error(`Unable to parse ${label}: ${error.message || error}`);
    }
  }

  parseSetCookies(setCookies) {
    return setCookies.reduce((cookieMap, cookieLine) => {
      const [pair] = String(cookieLine).split(';');
      const separatorIndex = pair.indexOf('=');
      if (separatorIndex === -1) {
        return cookieMap;
      }

      const name = pair.slice(0, separatorIndex).trim();
      const value = pair.slice(separatorIndex + 1).trim();
      if (name && value && value.toLowerCase() !== 'deleted') {
        cookieMap[name] = value;
      }

      return cookieMap;
    }, {});
  }

  formatCookieHeader(cookieMap) {
    return Object.entries(cookieMap)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  describeSessionState(charger, connector) {
    if (charger?.faulted) {
      return 'faulted';
    }

    if (charger?.charging) {
      return 'charging';
    }

    if (connector?.connectorStatusType) {
      return String(connector.connectorStatusType).toLowerCase();
    }

    if (charger?.pluggedIn) {
      return 'plugged-in';
    }

    return 'idle';
  }

  async sleep(milliseconds) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  setCommandedState(enabled) {
    if (enabled) {
      this.chargingSessionArmed = true;
      this.captureSessionBaseline();
    } else {
      this.resetEstimatedChargingSession();
      this.latestLivePowerWatts = 0;
      this.latestStreamSampleAt = 0;
      this.publishLivePowerUpdate(0);
    }

    this.commandedState = {
      enabled,
      active: enabled,
      powerWatts: enabled ? this.getRecentLivePowerWatts() : 0,
      sessionState: enabled ? 'charging' : 'idle'
    };
    this.commandedStateUntil = Date.now() + 60000;
  }

  getCommandedStateFallback(enabled) {
    return {
      enabled,
      active: enabled,
      powerWatts: enabled ? this.getRecentLivePowerWatts() : 0,
      sessionState: enabled ? 'charging' : 'idle'
    };
  }

  applyCommandedStateOverride(state) {
    if (!this.commandedState || Date.now() > this.commandedStateUntil) {
      this.commandedState = null;
      this.commandedStateUntil = 0;
      return state;
    }

    if (Boolean(state.enabled) === Boolean(this.commandedState.enabled)) {
      this.commandedState = null;
      this.commandedStateUntil = 0;
      return state;
    }

    return {
      ...state,
      enabled: this.commandedState.enabled,
      active: this.commandedState.active,
      sessionState: this.commandedState.sessionState,
      powerWatts: this.commandedState.enabled
        ? Math.max(
            Number.isFinite(state.powerWatts) ? state.powerWatts : 0,
            Number.isFinite(this.commandedState.powerWatts) ? this.commandedState.powerWatts : 0
          )
        : 0
    };
  }

  getRecentLivePowerWatts() {
    if (!this.latestStreamSampleAt) {
      return 0;
    }

    const ageMs = Date.now() - this.latestStreamSampleAt;
    if (ageMs > 120000) {
      return 0;
    }

    return Number.isFinite(this.latestLivePowerWatts) ? this.latestLivePowerWatts : 0;
  }

  publishLivePowerUpdate(powerWatts) {
    if (!this.onLivePowerUpdate || !Number.isFinite(powerWatts)) {
      return;
    }

    if (this.lastPublishedLivePowerWatts !== null && Math.abs(this.lastPublishedLivePowerWatts - powerWatts) < 1) {
      return;
    }

    this.lastPublishedLivePowerWatts = powerWatts;
    try {
      this.onLivePowerUpdate(powerWatts);
    } catch (error) {
      this.log.debug?.(`Live power update callback failed: ${error.message || error}`);
    }
  }

  shouldLogPowerSource(source, powerWatts) {
    if (!Number.isFinite(powerWatts)) {
      return false;
    }

    if (this.lastLoggedPowerSource !== source) {
      this.lastLoggedPowerSource = source;
      this.lastLoggedPowerWatts = powerWatts;
      return true;
    }

    if (!Number.isFinite(this.lastLoggedPowerWatts) || Math.abs(this.lastLoggedPowerWatts - powerWatts) >= 1000) {
      this.lastLoggedPowerWatts = powerWatts;
      return true;
    }

    return false;
  }

  normalizeEvseLivePayload(rawPayload) {
    if (!rawPayload) {
      return null;
    }

    let payload = rawPayload;
    if (typeof payload === 'string') {
      try {
        payload = JSON.parse(payload);
      } catch {
        return null;
      }
    }

    const normalized = {
      sn: this.chargerSerial,
      ts: payload.ts,
      u_ts: payload.ts,
      cc_s: payload.cc_s,
      ch_s: payload.ch_s,
      phaseCount: 1
    };

    this.assignPhaseMetric(normalized, 'power_W', payload.power_imp, true);
    this.assignPhaseMetric(normalized, 'energy_Wh', payload.energy_imp, true);
    this.assignPhaseMetric(normalized, 'ac_rms_v', payload.ac_rms_v_imp, true);
    this.assignPhaseMetric(normalized, 'ac_rms_i', payload.ac_rms_i_imp, true);
    this.assignPhaseMetric(normalized, 'ac_freq', payload.ac_freq_imp, false);
    this.assignPhaseMetric(normalized, 'power_W_exp', payload.power_exp, true);
    this.assignPhaseMetric(normalized, 'energy_Wh_exp', payload.energy_exp, true);
    this.assignPhaseMetric(normalized, 'ac_rms_v_exp', payload.ac_rms_v_exp, true);
    this.assignPhaseMetric(normalized, 'ac_rms_i_exp', payload.ac_rms_i_exp, true);
    this.assignPhaseMetric(normalized, 'meter', payload.meter, true);

    return normalized;
  }

  tryParseJsonPayload(payloadBuffer) {
    try {
      return JSON.parse(payloadBuffer.toString('utf8'));
    } catch {
      return null;
    }
  }

  tryDecodeDataMsgPayload(payloadBuffer) {
    try {
      const message = this.dataMsgType.decode(payloadBuffer);
      const object = this.dataMsgType.toObject(message, {
        longs: Number,
        defaults: false,
        enums: String
      });
      if (!object || !object.meters) {
        return null;
      }

      return object;
    } catch {
      return null;
    }
  }

  summarizeDataMsgPayload(dataMsgPayload) {
    const meters = dataMsgPayload?.meters || {};
    return {
      timestamp: dataMsgPayload?.timestamp ?? null,
      battMode: dataMsgPayload?.battMode ?? null,
      backupSoc: dataMsgPayload?.backupSoc ?? null,
      phaseCount: meters.phaseCount ?? null,
      isSplitPhase: meters.isSplitPhase ?? null,
      pvWatts: this.convertMilliUnitsToWatts(meters.pv?.aggPMw),
      storageWatts: this.convertMilliUnitsToWatts(meters.storage?.aggPMw),
      gridWatts: this.convertMilliUnitsToWatts(meters.grid?.aggPMw),
      loadWatts: this.convertMilliUnitsToWatts(meters.load?.aggPMw),
      generatorWatts: this.convertMilliUnitsToWatts(meters.generator?.aggPMw),
      dryContactRelayStatus: dataMsgPayload?.dryContactRelayStatus ?? [],
      loadStatus: dataMsgPayload?.loadStatus ?? []
    };
  }

  updateEstimatedPowerFromDataMsg(summary) {
    if (!summary || !Number.isFinite(summary.loadWatts)) {
      return null;
    }

    this.latestSiteLoadWatts = summary.loadWatts;

    if (!this.chargingSessionArmed) {
      this.lastKnownNonChargingLoadWatts = summary.loadWatts;
      this.lastKnownNonChargingLoadAt = Date.now();
      this.sessionEstimatedPowerWatts = 0;
      this.waitingForBaselineLogSent = false;
      return 0;
    }

    if (!Number.isFinite(this.sessionBaselineObservedWatts)) {
      this.sessionBaselineObservedWatts = summary.loadWatts;
    } else {
      this.sessionBaselineObservedWatts = Math.min(this.sessionBaselineObservedWatts, summary.loadWatts);
    }

    if (!Number.isFinite(this.sessionBaselineLoadWatts)) {
      this.captureSessionBaseline();
    }

    if (!Number.isFinite(this.sessionBaselineLoadWatts)) {
      this.sessionBaselineLoadWatts = this.sessionBaselineObservedWatts;
      this.waitingForBaselineLogSent = false;
      this.log.info?.(
        `Captured estimated charger baseline ${Math.round(this.sessionBaselineLoadWatts)} W from earliest charging-session site load.`
      );
    }

    const estimatedPowerWatts = Math.max(0, summary.loadWatts - this.sessionBaselineLoadWatts);
    this.sessionEstimatedPowerWatts = estimatedPowerWatts;

    if (estimatedPowerWatts > 0) {
      this.latestStreamSampleAt = Date.now();
      this.latestLivePowerWatts = estimatedPowerWatts;
    }

    return estimatedPowerWatts;
  }

  captureSessionBaseline() {
    const candidateBaseline = Number.isFinite(this.lastKnownNonChargingLoadWatts)
      ? this.lastKnownNonChargingLoadWatts
      : null;

    if (!Number.isFinite(candidateBaseline)) {
      return;
    }

    if (!Number.isFinite(this.sessionBaselineLoadWatts)) {
      this.sessionBaselineLoadWatts = candidateBaseline;
      this.waitingForBaselineLogSent = false;
      this.log.info?.(
        `Captured estimated charger baseline ${Math.round(this.sessionBaselineLoadWatts)} W from last known non-charging site load.`
      );
    }
  }

  resetEstimatedChargingSession() {
    this.chargingSessionArmed = false;
    this.sessionBaselineLoadWatts = null;
    this.sessionBaselineObservedWatts = null;
    this.sessionEstimatedPowerWatts = 0;
    this.waitingForBaselineLogSent = false;
  }

  convertMilliUnitsToWatts(value) {
    if (!Number.isFinite(value)) {
      return null;
    }

    return Math.round((value / 1000) * 100) / 100;
  }

  assignPhaseMetric(target, key, rawValue, roundNumbers) {
    const phaseValue = this.normalizePhaseValue(rawValue, roundNumbers);
    target[key] = phaseValue.agg;
    target[`${key}_l1`] = phaseValue.l1;
    target[`${key}_l2`] = phaseValue.l2;
    target[`${key}_l3`] = phaseValue.l3;
    target.phaseCount = Math.max(target.phaseCount || 0, phaseValue.phaseCount);
  }

  normalizePhaseValue(rawValue = {}, roundNumbers = false) {
    const l1 = typeof rawValue.l1 === 'number' ? rawValue.l1 : '--';
    const l2 = typeof rawValue.l2 === 'number' ? rawValue.l2 : '--';
    const l3 = typeof rawValue.l3 === 'number' ? rawValue.l3 : '--';
    const round = (value) => Math.round(value * 100) / 100;
    const activePhases = [l1, l2, l3].filter((value) => typeof value === 'number');

    return {
      agg: this.resolveAggregateValue(rawValue.agg, l1, l2, l3),
      l1: roundNumbers && typeof l1 === 'number' ? round(l1) : l1,
      l2: roundNumbers && typeof l2 === 'number' ? round(l2) : l2,
      l3: roundNumbers && typeof l3 === 'number' ? round(l3) : l3,
      phaseCount: activePhases.length
    };
  }

  resolveAggregateValue(aggregate, l1, l2, l3) {
    if (typeof aggregate === 'number') {
      return Math.round(aggregate * 100) / 100;
    }

    const phaseValues = [l1, l2, l3].filter((value) => typeof value === 'number');
    if (!phaseValues.length) {
      return '--';
    }

    return Math.round(Math.max(...phaseValues) * 100) / 100;
  }

  getAccessoryInfo() {
    return {
      manufacturer: this.configManufacturer || 'Enphase',
      serialNumber: this.chargerSerial || '',
      model: this.summaryModelName || this.configModel || '',
      firmwareRevision: this.summaryFirmwareVersion || this.configFirmwareRevision || ''
    };
  }

  getDiscoveredChargerMetadata() {
    return {
      modelName: this.summaryModelName || '',
      sku: this.summarySku || '',
      partNumber: this.summaryPartNumber || '',
      ratedCurrent: this.summaryRatedCurrent || 0,
      chargeLevelMax: this.summaryChargeLevelMax || 0,
      firmwareVersion: this.summaryFirmwareVersion || ''
    };
  }

  getResolvedChargingLevel() {
    const discoveredLimit = Math.max(
      this.parseFiniteNumber(this.summaryChargeLevelMax, 0),
      this.parseFiniteNumber(this.summaryRatedCurrent, 0)
    );

    if (!discoveredLimit) {
      return this.chargingLevel;
    }

    const resolvedLevel = Math.min(this.chargingLevel, discoveredLimit);
    if (resolvedLevel !== this.chargingLevel) {
      this.log.warn?.(
        `Configured chargingLevel ${this.chargingLevel}A exceeds charger capability; using ${resolvedLevel}A instead.`
      );
    }

    return resolvedLevel;
  }

  parseFiniteNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  readMappedValue(payload, path, fallback) {
    if (!path) {
      return fallback;
    }

    const value = path.split('.').reduce((current, key) => {
      if (current === null || current === undefined) {
        return undefined;
      }

      if (/^\d+$/.test(key)) {
        return current[Number(key)];
      }

      return current[key];
    }, payload);

    return value === undefined ? fallback : value;
  }
}

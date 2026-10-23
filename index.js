/**
 * Let the shipped Auto review preset be the new-session default, for real.
 *
 * Three host facts drive the design:
 *  1. Settings → General → Permission lists `defaultOptions` = `Object.keys(presets)`,
 *     so the reserved `auto` identity is published into the live preset table while
 *     the Auto review integration is live (and withdrawn when it is not);
 *  2. the row shows `view.value.defaultPreset ?? catalog.defaultPreset`, and
 *     `catalog.defaultPreset` comes from the service's `defaultSettings()`. Overriding
 *     that accessor makes the effective default `auto` with **no settings write**,
 *     while any stored choice still wins;
 *  3. a settings write runs inside the HMR runtime (`runExclusive`), which rejects any
 *     chain that descends from a mount transaction ("HMR transactions cannot be
 *     nested") — AsyncLocalStorage context survives timers. The durable seed therefore
 *     escapes that context through the runtime's own `executing.exit()`.
 *
 * Outcome is recorded in `<DSH_PROFILE_DIR>/auto-defaults-status.json`.
 *
 * @module @local/dsh-auto-default-effective
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Required service: the preset table owner and its write path. */
export const inject = ['permissionPresets'];

const AUTO = 'auto';
const AUTO_SPEC = { sandbox: 'danger-full-access', approval: 'ask' };
const FALLBACK = 'workspace-write';
const SETTINGS_NS = 'permission';
/** Durable-seed attempts, in milliseconds after mount. */
const SEED_DELAYS = [1200, 3000, 7000, 15000];

function text(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function own(object, key) {
  return object !== null && object !== undefined && Object.prototype.hasOwnProperty.call(object, key);
}

function unique(list) {
  const seen = new Set();
  const out = [];
  for (const name of list) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function reason(error) {
  if (error === null || error === undefined) return null;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * Publish Auto review as a selectable default, make it the effective default, and
 * persist that choice when the host permits it.
 *
 * @param ctx - plugin context (injects `permissionPresets`).
 * @param config - row config: `label`, `description`, `seedDefault`, `statusFile`.
 * @returns nothing.
 */
export function apply(ctx, config) {
  const service = ctx.permissionPresets;
  const label = text(config?.label) ?? '自动审查 (Auto review)';
  const description = text(config?.description)
    ?? '无沙箱；每次原生工具调用前由同一模型审查（实验性）。';
  const seedDefault = config?.seedDefault !== false;
  const directory = text(config?.statusDirectory) ?? process.env.DSH_PROFILE_DIR ?? process.cwd();
  const statusPath = text(config?.statusFile) ?? join(directory, 'auto-defaults-status.json');

  const report = { at: new Date().toISOString(), plugin: '@local/dsh-auto-default-effective', steps: [], facts: {} };
  const note = (step, detail) => {
    report.steps.push({ step, detail, at: new Date().toISOString() });
  };
  const flush = () => {
    try {
      writeFileSync(statusPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    } catch {
      /* An unwritable status file never blocks the fix. */
    }
  };

  if (service === null || service === undefined || service.presets === null || typeof service.presets !== 'object') {
    note('abort', 'the injected permissionPresets service has no preset table');
    flush();
    return;
  }

  const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined;
  const hmr = typeof ctx.get === 'function' ? ctx.get('hmr') : undefined;
  const als = hmr?.executing;
  const prototype = Object.getPrototypeOf(service);
  const namesDescriptor = prototype === null ? undefined : Object.getOwnPropertyDescriptor(prototype, 'names');
  const readHostNames = namesDescriptor?.get !== undefined
    ? () => namesDescriptor.get.call(service)
    : () => Object.keys(service.presets);
  const live = () => {
    const admit = service.autoAdmit;
    return admit !== undefined && admit !== null;
  };

  const invalidate = () => {
    try {
      service.emitCatalogChanged?.();
    } catch (error) {
      note('invalidate:failed', reason(error));
    }
  };

  const permissionRow = () => {
    if (settings === undefined || settings === null || typeof settings.describe !== 'function') return undefined;
    const rows = settings.describe();
    if (!Array.isArray(rows)) return undefined;
    return rows.find((row) => row !== null && typeof row === 'object'
      && (row.ns === SETTINGS_NS || (typeof row.ns === 'string' && row.ns.endsWith(`:${SETTINGS_NS}`))));
  };
  const storedDefault = () => {
    try {
      return permissionRow()?.user?.defaultPreset;
    } catch (error) {
      report.facts.describeError = reason(error);
      return undefined;
    }
  };

  // --- 1. publish the reserved identity in the live preset table -----------
  let injected = false;
  const restore = [];
  const syncTable = () => {
    const isLive = live();
    const present = own(service.presets, AUTO);
    if (isLive && !present) {
      service.presets[AUTO] = {
        sandbox: AUTO_SPEC.sandbox,
        approval: AUTO_SPEC.approval,
        name: label,
        description,
      };
      injected = true;
      note('publish', `presets.${AUTO} published`);
      invalidate();
      return true;
    }
    if (!isLive && present && injected) {
      delete service.presets[AUTO];
      injected = false;
      note('withdraw', 'the Auto review integration is not live');
      invalidate();
      return true;
    }
    note('publish:unchanged', isLive ? 'auto is already published' : 'the integration is not live');
    return false;
  };

  // --- 2. dedupe `names` (the live integration appends auto as well) --------
  const needNames = () => own(service.presets, AUTO) && !own(service, 'names');
  const installNames = () => {
    if (!needNames() || namesDescriptor?.get === undefined) return;
    Object.defineProperty(service, 'names', {
      configurable: true,
      get() {
        return unique(readHostNames());
      },
    });
    restore.push(() => {
      delete service.names;
    });
    note('names', `deduped -> ${JSON.stringify(service.names)}`);
  };

  // --- 3. make the effective default `auto` while nothing is stored ---------
  // Guarded by integration liveness: publishing the identity is what makes
  // `resolve("auto")` work while a session is being published, and during early
  // boot the integration may not have registered yet. Falling back to the host
  // default in that window keeps session publication safe.
  const hostDefaultSettings = service.defaultSettings;
  let overridden = false;
  if (typeof hostDefaultSettings === 'function') {
    service.defaultSettings = () => {
      if (!live()) return hostDefaultSettings();
      const stored = storedDefault();
      if (stored === undefined) return { defaultPreset: AUTO };
      return hostDefaultSettings();
    };
    overridden = true;
    restore.push(() => {
      service.defaultSettings = hostDefaultSettings;
    });
    note('effective-default', 'defaultSettings() reports auto while no choice is stored');
  }

  // --- 4. persist the choice durably, outside any HMR transaction -----------
  const timers = [];
  let attempt = 0;
  let settled = false;
  const outsideTransaction = (operation) => (typeof als?.exit === 'function' ? als.exit(operation) : operation());

  const attemptSeed = async () => {
    if (settled) return 'settled';
    if (!seedDefault) return 'disabled';
    if (!live()) return 'notlive';
    if (typeof settings?.mutate !== 'function') return 'unavailable';
    const row = permissionRow();
    if (row === undefined) return 'unavailable';
    const stored = row.user?.defaultPreset;
    report.facts.permissionRowNs = row.ns;
    report.facts.storedDefaultBefore = stored ?? null;
    if (stored !== undefined) return stored === AUTO ? 'already' : 'user-choice';
    const result = await outsideTransaction(() => settings.mutate(row.ns, [{
      op: 'set',
      path: ['defaultPreset'],
      value: AUTO,
    }]));
    note('seed:escaped', `mutate resolved (als=${typeof als?.exit === 'function' ? 'used' : 'absent'})`);
    return result === false ? 'unavailable' : 'written';
  };

  const scheduleSeed = () => {
    if (settled) return;
    if (attempt >= SEED_DELAYS.length) {
      settled = true;
      report.facts.seedOutcome = 'gave-up';
      note('seed:gave-up', `no attempt succeeded after ${SEED_DELAYS.length} tries`);
      flush();
      return;
    }
    const delay = SEED_DELAYS[attempt];
    attempt += 1;
    timers.push(setTimeout(() => {
      void attemptSeed().then((outcome) => {
        note('seed', outcome);
        if (outcome === 'error') {
          scheduleSeed();
          return;
        }
        settled = true;
        report.facts.seedOutcome = outcome;
        flush();
      }).catch((error) => {
        note('seed:error', reason(error));
        scheduleSeed();
      });
    }, delay));
  };

  // --- mount ---------------------------------------------------------------
  ctx.effect(() => {
    report.facts.integrationLive = live();
    report.facts.presetKeysBefore = Object.keys(service.presets);
    report.facts.hostNamesBefore = readHostNames();
    report.facts.hasSettingsService = settings !== undefined && settings !== null;
    report.facts.hasHmrService = als !== undefined && als !== null;
    report.facts.storedDefault = storedDefault() ?? null;
    syncTable();
    installNames();
    report.facts.presetKeysAfter = Object.keys(service.presets);
    report.facts.effectiveDefault = (() => {
      try {
        return service.defaultSettings().defaultPreset;
      } catch (error) {
        return reason(error);
      }
    })();
    if (seedDefault && live()) scheduleSeed();
    const off = ctx.on('permission-presets/catalog-changed', () => {
      const changed = syncTable();
      if (needNames()) installNames();
      if (changed && !live() && storedDefault() === AUTO) {
        void outsideTransaction(() => settings?.mutate?.(SETTINGS_NS, [{
          op: 'set',
          path: ['defaultPreset'],
          value: FALLBACK,
        }])).then(() => note('restore', `defaultPreset -> ${FALLBACK}`)).catch(() => {});
      }
    });
    flush();
    return () => {
      off();
      for (const timer of timers) clearTimeout(timer);
      timers.length = 0;
      for (const undo of restore.reverse()) undo();
      if (injected) {
        delete service.presets[AUTO];
        injected = false;
      }
      if (overridden) note('dispose', 'default override removed');
      invalidate();
    };
  }, 'auto-default-effective: auto as the selected default');
}

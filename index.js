/**
 * Make the shipped Auto review preset the effective new-session default, and make
 * that choice impossible to turn into a broken permission service.
 *
 * Host facts this build is built around (all verified against the shipped code):
 *
 *  1. Settings → General → Permission renders its "default preset" select from
 *     `catalog.defaultOptions` and *throws* when the current value is not in that
 *     list (`dsh-client-ui-permission-presets/lib/client.js`:
 *     `"permission catalog does not advertise its current default"`). So `auto`
 *     must appear in the advertised table while the integration is live.
 *  2. The row shows `view.value.defaultPreset ?? catalog.defaultPreset`, and
 *     `catalog.defaultPreset` comes from `defaultSettings()`. Overriding that
 *     accessor makes the effective default `auto` with **no settings write**, and any
 *     stored choice still wins.
 *  3. `service.presets` is not a copy: `@deepseek-ai/dsh-permission-presets` assigns
 *     `this.presets = config.presets`, and Cordis hands the plugin the *same* object it
 *     keeps as `fiber.config` (`@deepseek-ai/cordis` `_runner.execute` →
 *     `runtime.callback(this.ctx, this.config)`). Writing a key into `presets`
 *     therefore edits the host's live resolved config in place.
 *  4. The loader compares the running `fiber.config` with a fresh schema resolution to
 *     decide between a cheap volatile update and a full restart
 *     (`@deepseek-ai/cordis-plugin-loader` `config/entry.ts` `_commitVolatile()` →
 *     `deepEqual(fiber.config, candidate, true)`). One extra `presets.auto` key makes
 *     that comparison fail, so every settings edit of the `permission` entry fell back
 *     to `fiber.update()` — a restart of the service and of its dependents. While it
 *     restarts the provider fiber is not ACTIVE, and `ctx.get(name, strict)` skips
 *     inactive providers (`@deepseek-ai/cordis` `_getImpl`: `impl.fiber.state !== 2`),
 *     so the gateway answered the client's follow-up call with
 *     `gateway/service-unavailable: permissionPresets/catalog: active Service
 *     "permissionPresets" is unavailable`.
 *  5. `auto` is a *reserved runtime identity*, not a stored one: the host resolves the
 *     configured default inside its constructor, before the integration can publish
 *     the identity (`@deepseek-ai/dsh-permission-presets` `new PermissionPresetService`
 *     → `this.resolve(defaultPreset)`), so a persisted `defaultPreset: "auto"` makes
 *     the service fail to mount on every later boot. A failed provider exposes no
 *     settings row, so nothing inside the profile can repair it afterwards.
 *
 * Design, therefore:
 *  - Auto is published by replacing the service **instance's** `presets` with a derived
 *    table; `config.presets` keeps its identity, so fact (4) never fires and a settings
 *    edit stays a hot volatile update.
 *  - The effective default comes from the `defaultSettings()` override (fact 2), so no
 *    `defaultPreset` is ever written by this plugin.
 *  - Writes that would persist the reserved identity are translated into "clear the
 *    field" (`set defaultPreset=auto` → `unset defaultPreset`): the UI keeps showing
 *    Auto through `catalog.defaultPreset`, while the profile never stores a value the
 *    host cannot resolve on the next boot (fact 5).
 *  - As defense in depth, an `internal/config` waterfall drops such a value before it
 *    reaches the host constructor, for anything that reached the loader by another
 *    route (manual patch edit, an older build, a future UI).
 *
 * Outcome is recorded in `<DSH_PROFILE_DIR>/auto-defaults-status.json`.
 *
 * @module @local/dsh-auto-default-effective
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const AUTO = 'auto';
const AUTO_SPEC = Object.freeze({ sandbox: 'danger-full-access', approval: 'ask' });
const SETTINGS_NS = 'permission';

function text(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function own(object, key) {
  return object !== null && object !== undefined && Object.prototype.hasOwnProperty.call(object, key);
}

function isTable(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

/** Read a prototype getter without assuming it sits on the first prototype. */
function findGetter(object, property) {
  let prototype = Object.getPrototypeOf(object);
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (descriptor !== undefined) return descriptor.get;
    prototype = Object.getPrototypeOf(prototype);
  }
  return undefined;
}

/** JSON-safe summary of permission settings-write arguments. */
function briefArgs(rest) {
  try {
    const first = rest[0];
    if (Array.isArray(first)) return first.map((op) => ({ op: op?.op, path: op?.path, value: op?.value }));
    if (isTable(first)) return first;
    return null;
  } catch {
    return 'unreadable';
  }
}

/** JSON-safe summary of a settings-write answer. */
function briefResult(value) {
  try {
    if (!isTable(value)) return typeof value;
    const inner = isTable(value.value) ? value.value : undefined;
    return {
      ok: value.ok ?? null,
      error: text(value.error) ?? null,
      revision: inner?.revision ?? null,
      userDefault: inner?.user?.defaultPreset ?? null,
      effectiveDefault: inner?.value?.defaultPreset ?? null,
    };
  } catch {
    return 'unreadable';
  }
}

/** Profile entry ids the permission service may be composed under. */
function isPermissionNamespace(ns) {
  return typeof ns === 'string' && (ns === SETTINGS_NS || ns.endsWith(`:${SETTINGS_NS}`));
}

/** Whether a fiber (or its loader entry) belongs to the permission-presets plugin. */
function isPermissionFiber(fiber) {
  try {
    if (typeof fiber?.runtime?.name === 'string' && fiber.runtime.name.includes('PermissionPreset')) return true;
    const entry = fiber?.ctx?.[Symbol.for('cordis.entry')];
    return isPermissionNamespace(entry?.options?.id);
  } catch {
    return false;
  }
}

/**
 * Drop a reserved `defaultPreset` from a raw entry config.
 *
 * The host resolves its configured default inside the constructor, before the Auto
 * integration can publish the reserved identity, so such a value would make the
 * service fail to mount. Removing it lets the host fall back to its inferred default,
 * and the effective default is then supplied by `defaultSettings()`.
 *
 * @param config - the raw config the loader is about to resolve.
 * @param fiber - the fiber being resolved, when the caller knows it.
 * @returns the normalized config, or the value unchanged.
 */
export function normalizeReservedDefault(config, fiber) {
  if (!isTable(config) || config.defaultPreset !== AUTO) return config;
  if (!isTable(config.presets) && !isPermissionFiber(fiber)) return config;
  const { defaultPreset, ...rest } = config;
  void defaultPreset;
  return rest;
}

/**
 * Translate a section patch that would persist the reserved identity.
 *
 * @param ns - profile entry id the write targets.
 * @param section - merged field values, or `undefined` when not a plain object.
 * @returns the rewritten section.
 */
function clearReservedDefault(ns, section) {
  if (!isPermissionNamespace(ns) || !isTable(section) || section.defaultPreset !== AUTO) return section;
  const { defaultPreset, ...rest } = section;
  void defaultPreset;
  return rest;
}

/**
 * Translate ordered form edits that would persist the reserved identity.
 *
 * @param ns - profile entry id the write targets.
 * @param ops - ordered edits, or `undefined`.
 * @returns the rewritten edits.
 */
function clearReservedDefaultOps(ns, ops) {
  if (!isPermissionNamespace(ns) || !Array.isArray(ops)) return ops;
  let changed = false;
  const next = ops.map((op) => {
    if (!isTable(op) || op.op !== 'set' || op.value !== AUTO) return op;
    if (!Array.isArray(op.path) || op.path.length !== 1 || op.path[0] !== 'defaultPreset') return op;
    changed = true;
    return { op: 'unset', path: [...op.path] };
  });
  return changed ? next : ops;
}

/**
 * Publish Auto review as a selectable preset, make it the effective default, and keep
 * the reserved identity out of the persisted profile config.
 *
 * @param ctx - plugin context.
 * @param config - row config: `label`, `description`, `seedDefault`, `statusFile`.
 * @returns nothing.
 */
export function apply(ctx, config) {
  const enabled = config?.seedDefault !== false;
  const label = text(config?.label) ?? '自动审查 (Auto review)';
  const description = text(config?.description)
    ?? '无沙箱；每次原生工具调用前由同一模型审查（实验性）。';
  const directory = text(config?.statusDirectory) ?? process.env.DSH_PROFILE_DIR ?? process.cwd();
  const statusPath = text(config?.statusFile) ?? join(directory, 'auto-defaults-status.json');

  const report = {
    at: new Date().toISOString(),
    plugin: '@local/dsh-auto-default-effective',
    design: 'instance-level preset table, no host config mutation, reserved default never persisted',
    steps: [],
    facts: {},
  };
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

  // Services are resolved on demand: `settings` may mount after this plugin, and a
  // late provider must not leave a stale reference behind.
  const serviceOf = (name) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  };

  // --- guard: never let a reserved default reach the host constructor ----------
  if (enabled) {
    ctx.on('internal/config', function (raw, next) {
      const resolved = next();
      try {
        const normalized = normalizeReservedDefault(resolved, this);
        if (normalized !== resolved) note('guard', 'dropped a reserved defaultPreset before config resolution');
        return normalized;
      } catch (error) {
        note('guard:failed', reason(error));
        return resolved;
      }
    });
  }

  const permissionRow = () => {
    const settings = serviceOf('settings');
    if (settings === null || settings === undefined || typeof settings.describe !== 'function') return undefined;
    let rows;
    try {
      rows = settings.describe();
    } catch (error) {
      report.facts.describeError = reason(error);
      return undefined;
    }
    if (!Array.isArray(rows)) return undefined;
    return rows.find((row) => row !== null && typeof row === 'object' && isPermissionNamespace(row.ns));
  };
  const storedDefault = () => {
    try {
      return permissionRow()?.user?.defaultPreset;
    } catch (error) {
      report.facts.describeError = reason(error);
      return undefined;
    }
  };

  // --- read the configured default straight from the Loader --------------------
  // `settings.describe()` is a heavy, side-effecting read: it rebuilds every row,
  // bumps document revisions and emits `settings/document-updated`. Resolving the
  // effective default on every catalog read must not depend on it — and must not
  // perturb the revision the settings row writes against. The Loader entry carries
  // both the raw config the profile persisted and the resolved config the running
  // service actually uses, which is exactly the pair needed here.
  const permissionEntry = () => {
    let loose;
    for (const name of ['loader', 'configEditor']) {
      const owner = serviceOf(name);
      if (owner === null || owner === undefined || typeof owner.entries !== 'function') continue;
      let entries;
      try {
        entries = [...owner.entries()];
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (isTable(entry?.fiber?.config) && isTable(entry.fiber.config.presets)) return entry;
        if (entry?.options?.name === '@deepseek-ai/dsh-permission-presets') loose ??= entry;
      }
    }
    return loose;
  };
  const readDefault = (config) => {
    if (!isTable(config)) return undefined;
    const value = config.defaultPreset;
    if (typeof value === 'string') return value;
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
      const current = value.get();
      return typeof current === 'string' ? current : undefined;
    }
    return undefined;
  };
  /**
   * The default this deployment actually configured, or `undefined` when none is.
   *
   * Ordered most to least authoritative: the resolved config the running service uses,
   * the raw config the profile persisted, then the effective value the settings row
   * itself displays. The last fallback keeps new sessions consistent with what the user
   * sees on screen even when the Loader service is not reachable from this context.
   */
  const configuredDefault = () => {
    const entry = permissionEntry();
    if (entry !== undefined) {
      const effective = readDefault(entry.fiber?.config);
      if (effective !== undefined) return effective;
      const raw = readDefault(entry.options?.config);
      if (raw !== undefined) return raw;
    }
    try {
      const shown = permissionRow()?.value?.defaultPreset;
      return typeof shown === 'string' ? shown : undefined;
    } catch (error) {
      note('default:unreadable', reason(error));
      return undefined;
    }
  };

  // --- publish Auto on the service instance, never in the host config ----------
  // `ctx.inject` keeps this plugin mounted even while the service is unavailable, so a
  // broken provider cannot cascade into this entry and the report still lands.
  ctx.inject(['permissionPresets'], (child) => {
    const service = child.permissionPresets;
    const hostTable = service?.presets;
    if (!isTable(hostTable)) {
      note('abort', 'the injected permissionPresets service has no preset table');
      flush();
      return;
    }

    report.facts.integrationLive = service.autoAdmit !== undefined && service.autoAdmit !== null;
    report.facts.hostPresetKeys = Object.keys(hostTable);
    report.facts.presetEntry = permissionEntry()?.options?.id ?? null;
    report.facts.configuredDefault = configuredDefault() ?? null;
    report.facts.describedDefault = storedDefault() ?? null;

    // A previous build wrote the identity straight into the host's live config.
    // Removing it restores the loader's hot volatile update path for that entry.
    if (own(hostTable, AUTO)) {
      try {
        delete hostTable[AUTO];
        note('scrub', 'removed a stale presets.auto from the host plugin config');
      } catch (error) {
        note('scrub:failed', reason(error));
      }
    }

    const alive = () => service.autoAdmit !== undefined && service.autoAdmit !== null;
    const hostNames = (() => {
      const getter = findGetter(service, 'names');
      return getter === undefined ? () => Object.keys(service.presets) : () => getter.call(service);
    })();

    let published = false;
    let namesInstalled = false;

    const invalidate = () => {
      try {
        service.emitCatalogChanged?.();
      } catch (error) {
        note('invalidate:failed', reason(error));
      }
    };

    const installNames = () => {
      if (namesInstalled) return;
      try {
        // The live integration appends `auto` on its own as well, and the derived table
        // already carries it, so the advertised list has to be deduplicated.
        Object.defineProperty(service, 'names', {
          configurable: true,
          enumerable: true,
          get: () => unique(hostNames()),
        });
        namesInstalled = true;
        report.facts.names = service.names;
        note('names', `deduped -> ${JSON.stringify(service.names)}`);
      } catch (error) {
        note('names:failed', reason(error));
      }
    };
    const withdrawNames = () => {
      if (!namesInstalled) return;
      namesInstalled = false;
      try {
        delete service.names;
      } catch (error) {
        note('names:restore-failed', reason(error));
      }
    };

    const syncTable = () => {
      const want = enabled && alive();
      try {
        if (want && !published) {
          // Derived table on the instance: `config.presets` keeps its exact identity, so
          // the loader still takes the hot volatile path for settings edits.
          service.presets = { ...hostTable, [AUTO]: { ...AUTO_SPEC, name: label, description } };
          published = true;
          report.facts.publishedKeys = Object.keys(service.presets);
          note('publish', 'presets.auto published on the service instance (host config untouched)');
          installNames();
          invalidate();
          return true;
        }
        if (!want && published) {
          service.presets = hostTable;
          published = false;
          note('withdraw', enabled ? 'the Auto review integration is not live' : 'disabled by config');
          withdrawNames();
          invalidate();
          return true;
        }
      } catch (error) {
        note('publish:failed', reason(error));
        return false;
      }
      note('publish:unchanged', want ? 'auto is already published' : 'the integration is not live');
      return false;
    };

    // --- the effective default is auto while nothing else is stored ----------
    const hostDefaultSettings = service.defaultSettings;
    let overridden = false;
    if (enabled && typeof hostDefaultSettings === 'function') {
      try {
        service.defaultSettings = () => {
          if (!published || !alive()) return hostDefaultSettings();
          const configured = configuredDefault();
          if (configured !== undefined && configured !== AUTO) return hostDefaultSettings();
          return { defaultPreset: AUTO };
        };
        overridden = true;
        note('effective-default', 'defaultSettings() reports auto while no other choice is stored');
      } catch (error) {
        note('effective-default:failed', reason(error));
      }
    }

    const restore = () => {
      if (overridden) {
        overridden = false;
        try {
          service.defaultSettings = hostDefaultSettings;
        } catch (error) {
          note('dispose:default-failed', reason(error));
        }
        note('dispose', 'default override removed');
      }
      withdrawNames();
      if (published) {
        published = false;
        try {
          service.presets = hostTable;
        } catch (error) {
          note('dispose:presets-failed', reason(error));
        }
      }
    };

    // --- mount --------------------------------------------------------------
    syncTable();
    try {
      report.facts.effectiveDefault = service.defaultSettings().defaultPreset;
    } catch (error) {
      report.facts.effectiveDefault = reason(error);
    }
    const off = child.on('permission-presets/catalog-changed', () => {
      syncTable();
    });
    flush();
    child.effect(() => () => {
      off();
      restore();
      invalidate();
    }, 'auto-default-effective: auto as the selected default');
  });

  // --- keep the reserved identity out of the persisted profile config ---------
  // `set defaultPreset=auto` becomes `unset defaultPreset`: the row still shows Auto
  // through `catalog.defaultPreset`, and the profile never stores a value the host
  // cannot resolve while it mounts.
  if (enabled) {
    ctx.inject(['settings'], (child) => {
      const settings = child.settings;
      const originals = new Map();
      const wrap = (name, translate) => {
        const original = settings[name];
        if (typeof original !== 'function') return;
        originals.set(name, { own: own(settings, name), original });
        settings[name] = function (...args) {
          let nextArgs = args;
          let rewrote = false;
          try {
            nextArgs = translate(args);
            rewrote = nextArgs !== args;
            if (rewrote) {
              report.facts.reservedWrites = (report.facts.reservedWrites ?? 0) + 1;
              note('reserved-write', `cleared a reserved ${AUTO} default instead of persisting it`);
            }
          } catch (error) {
            note('reserved-write:failed', reason(error));
            nextArgs = args;
          }
          // The original is a traceable shadow method: it needs the receiver it was read from.
          const result = original.apply(settings, nextArgs);
          try {
            if (isPermissionNamespace(args[0])) {
              report.facts.lastWrite = { method: name, cleared: rewrote, args: briefArgs(args.slice(1)) };
              if (result !== null && typeof result?.then === 'function') {
                result.then((value) => {
                  report.facts.lastWriteResult = briefResult(value);
                  report.facts.configuredDefault = configuredDefault() ?? null;
                  note('write', `permission/${name} settled`);
                  flush();
                }, (error) => {
                  report.facts.lastWriteError = reason(error);
                  note('write:rejected', reason(error));
                  flush();
                });
              } else {
                report.facts.configuredDefault = configuredDefault() ?? null;
                flush();
              }
            }
          } catch (error) {
            note('write:trace-failed', reason(error));
          }
          return result;
        };
      };
      wrap('mutate', (args) => {
        const [ns, ops, ...tail] = args;
        const next = clearReservedDefaultOps(ns, ops);
        return next === ops ? args : [ns, next, ...tail];
      });
      wrap('update', (args) => {
        const [ns, patch, ...tail] = args;
        const next = clearReservedDefault(ns, patch);
        return next === patch ? args : [ns, next, ...tail];
      });
      wrap('replace', (args) => {
        const [ns, section, ...tail] = args;
        const next = clearReservedDefault(ns, section);
        return next === section ? args : [ns, next, ...tail];
      });
      child.effect(() => () => {
        for (const [name, entry] of originals) {
          try {
            if (entry.own) settings[name] = entry.original;
            else delete settings[name];
          } catch {
            /* A service being torn down needs no clean-up. */
          }
        }
      }, 'auto-default-effective: reserved default write guard');
    });
  }

  ctx.effect(() => {
    report.facts.enabled = enabled;
    report.facts.hasSettingsService = serviceOf('settings') !== undefined;
    report.facts.presetEntry = permissionEntry()?.options?.id ?? null;
    report.facts.configuredDefault = configuredDefault() ?? null;
    report.facts.describedDefault = storedDefault() ?? null;
    flush();
    return () => flush();
  }, 'auto-default-effective: report');
}

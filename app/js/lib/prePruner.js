// prePruner.js
//
// Pre-prunes items from the optimizer's search input based on ABSOLUTE
// criteria, independent of the rank-based priorityFilter.js (which keeps
// top-N% per slot by weighted score). Runs after applyItemFilters' existing
// hard filters and after PriorityFilter, just before the items are shipped
// to the Java optimizer.
//
// Two rules, both off-by-default-safe:
//
//   (A) Substat care-count rule.
//       Stats are partitioned into:
//         careSet      = stats with slider > 0 OR with a min/max limit set
//         superBuckets = stats whose slider is set to 4 (the new "super
//                        priority" slot). Items with a "large" contribution
//                        to ANY super bucket bypass the n_cared check.
//       For each item, count substats whose stat ∈ careSet (→ n_cared).
//         n_cared >= 2                           → keep
//         n_cared <  2, super-threshold reached  → keep (super exception)
//         otherwise                              → drop
//       Super-thresholds (item's total contribution to that stat):
//         atk/hp/def/eff/res = 35,   spd = 16,   cr = 15,   cd = 28
//       For atk/hp/def the threshold is "% of hero base", so the raw
//       flat contribution is normalised by base before comparing.
//
//   (B) Loose per-stat upper-bound rule (linear stats only).
//       For each stat with a min-limit set, compute the most the build
//       could ever reach with this item locked into its slot:
//             upper = base + heroBonuses + maxApplicableSetBonus
//                   + thisItem's_contribution
//                   + Σ over other 5 slots: bestContribution(slot, stat)
//       If upper < minLimit, drop. We only apply this to stats whose final
//       value is a linear sum of inputs (SPD, CR, CD, EFF, RES). ATK/HP/DEF
//       pass through StatCalculator's final multiplier and the math is
//       fiddly enough that a v1 should not risk it; falling back to the
//       care-count rule + existing PriorityFilter is plenty for those.
//
// Items currently equipped on the target hero ALWAYS bypass the prune so
// that "Keep current items" still has something to keep.
//
// Returns { items, diagnostics } so callers can log drop counts.

const GEAR_SLOTS = ['Weapon', 'Helmet', 'Armor', 'Necklace', 'Ring', 'Boots'];

// Mapping from item substat type (StatType @SerializedName form) → the
// coarse stat "bucket" used internally. Flat and % share a bucket.
const SUBSTAT_TO_BUCKET = {
    Attack:                    'atk',
    AttackPercent:             'atk',
    Health:                    'hp',
    HealthPercent:             'hp',
    Defense:                   'def',
    DefensePercent:            'def',
    Speed:                     'spd',
    CriticalHitChancePercent:  'cr',
    CriticalHitDamagePercent:  'cd',
    EffectivenessPercent:      'eff',
    EffectResistancePercent:   'res',
};

const SLIDER_FOR_BUCKET = {
    atk: 'inputAtkPriority',
    hp:  'inputHpPriority',
    def: 'inputDefPriority',
    spd: 'inputSpdPriority',
    cr:  'inputCrPriority',
    cd:  'inputCdPriority',
    eff: 'inputEffPriority',
    res: 'inputResPriority',
};

const MIN_LIMIT_FOR_BUCKET = {
    atk: 'inputAtkMinLimit',
    hp:  'inputHpMinLimit',
    def: 'inputDefMinLimit',
    spd: 'inputSpdMinLimit',
    cr:  'inputCrMinLimit',
    cd:  'inputCdMinLimit',
    eff: 'inputEffMinLimit',
    res: 'inputResMinLimit',
};

const MAX_LIMIT_FOR_BUCKET = {
    atk: 'inputAtkMaxLimit',
    hp:  'inputHpMaxLimit',
    def: 'inputDefMaxLimit',
    spd: 'inputSpdMaxLimit',
    cr:  'inputCrMaxLimit',
    cd:  'inputCdMaxLimit',
    eff: 'inputEffMaxLimit',
    res: 'inputResMaxLimit',
};

// Stats whose final value is a linear sum (no multiplicative term in
// StatCalculator.addAccumulatorArrsToHero). Upper-bound rule applies only
// to these in v1.
const LINEAR_BUCKETS = ['spd', 'cr', 'cd', 'eff', 'res'];

// Per-bucket threshold for the "super priority" (slider == 4) exception.
// For atk/hp/def these are PERCENT-OF-BASE; for spd the unit is flat speed;
// for cr/cd/eff/res the unit is the raw percentage value (e.g. 15 means
// "+15% crit chance worth of contribution from this single item").
const SUPER_SLIDER_VALUE = 4;
const SUPER_THRESHOLDS = {
    atk: 35, hp: 35, def: 35,
    spd: 16,
    cr: 15, cd: 28,
    eff: 35, res: 35,
};

const MODE_OFF      = 0;
const MODE_ON       = 1;
const MODE_ON_PLUS  = 2; // reserved for future WSS-percentile drop

// ---- Helpers ----

function isFiniteNumber(v) {
    return typeof v === 'number' && !isNaN(v) && isFinite(v);
}

function isMinLimitSet(v) { return isFiniteNumber(v) && v > 0; }
// readNumber() returns undefined for blank max fields, so any finite value
// here is an actual user-imposed cap.
function isMaxLimitSet(v) { return isFiniteNumber(v); }

function computeCareSet(params) {
    const careSet = new Set();
    const positiveSliderBuckets = [];
    for (const bucket of Object.keys(SLIDER_FOR_BUCKET)) {
        const v = params[SLIDER_FOR_BUCKET[bucket]];
        if (isFiniteNumber(v) && v > 0) {
            careSet.add(bucket);
            positiveSliderBuckets.push(bucket);
        }
    }
    for (const bucket of Object.keys(MIN_LIMIT_FOR_BUCKET)) {
        if (isMinLimitSet(params[MIN_LIMIT_FOR_BUCKET[bucket]]) ||
            isMaxLimitSet(params[MAX_LIMIT_FOR_BUCKET[bucket]])) {
            careSet.add(bucket);
        }
    }
    // Super buckets: stats whose slider is at the SUPER_SLIDER_VALUE (4).
    // Items whose single-piece contribution to ANY super bucket exceeds the
    // per-bucket threshold are kept even if n_cared < 2.
    const superBuckets = new Set();
    for (const bucket of Object.keys(SLIDER_FOR_BUCKET)) {
        const v = params[SLIDER_FOR_BUCKET[bucket]];
        if (isFiniteNumber(v) && v >= SUPER_SLIDER_VALUE) {
            superBuckets.add(bucket);
        }
    }
    return { careSet, superBuckets };
}

// Returns the item's contribution to `bucket` expressed in the SAME UNITS
// as SUPER_THRESHOLDS. For atk/hp/def this is "percent of hero base";
// for everything else it's the raw value from contribution().
function contributionInThresholdUnits(item, bucket, baseStats) {
    const raw = contribution(item, bucket, baseStats);
    if (bucket === 'atk') {
        const base = baseStats.atk || 0;
        return base > 0 ? (raw / base) * 100 : 0;
    }
    if (bucket === 'hp') {
        const base = baseStats.hp || 0;
        return base > 0 ? (raw / base) * 100 : 0;
    }
    if (bucket === 'def') {
        const base = baseStats.def || 0;
        return base > 0 ? (raw / base) * 100 : 0;
    }
    return raw;
}

// Returns the additive contribution of `item` to a stat `bucket`, in the
// same units as the bucket's final value. % stats are linearised against
// hero base (matching StatCalculator.buildStatAccumulatorArr).
function contribution(item, bucket, baseStats) {
    const stats = item.augmentedStats || {};
    const baseAtk = baseStats.atk || 0;
    const baseHp  = baseStats.hp  || 0;
    const baseDef = baseStats.def || 0;

    let v = 0;
    switch (bucket) {
        case 'atk':
            v = (stats.Attack || 0) + (stats.AttackPercent || 0) / 100 * baseAtk;
            break;
        case 'hp':
            v = (stats.Health || 0) + (stats.HealthPercent || 0) / 100 * baseHp;
            break;
        case 'def':
            v = (stats.Defense || 0) + (stats.DefensePercent || 0) / 100 * baseDef;
            break;
        case 'spd': v = stats.Speed || 0; break;
        case 'cr':  v = stats.CriticalHitChancePercent || 0; break;
        case 'cd':  v = stats.CriticalHitDamagePercent || 0; break;
        case 'eff': v = stats.EffectivenessPercent || 0; break;
        case 'res': v = stats.EffectResistancePercent || 0; break;
    }

    // The accumulator includes the item's main-stat too. Mirror that here so
    // a Speed-main boots is counted as a strong speed contributor.
    const mainType = (item.main && item.main.type) || null;
    if (mainType) {
        const mainBucket = SUBSTAT_TO_BUCKET[mainType];
        if (mainBucket === bucket) {
            const mainValue = (item.main && item.main.value) || 0;
            if (mainType === 'AttackPercent')       v += mainValue / 100 * baseAtk;
            else if (mainType === 'HealthPercent')  v += mainValue / 100 * baseHp;
            else if (mainType === 'DefensePercent') v += mainValue / 100 * baseDef;
            else                                    v += mainValue;
        }
    }

    return v;
}

// Generous upper bound on the set bonus the 6-piece build could supply for
// `bucket`. We assume every stat-affecting set is reachable (loose bound),
// and stack 2pc-style sets to their 6pc maximum where the math allows. This
// is intentionally over-permissive: false drops are forbidden.
function maxSetBonusForBucket(bucket, baseStats) {
    const baseSpd = baseStats.spd || 0;
    const baseHp  = baseStats.hp  || 0;
    const baseDef = baseStats.def || 0;
    const baseAtk = baseStats.atk || 0;
    switch (bucket) {
        // Linear buckets (the only ones the upper-bound rule actually uses):
        case 'spd':
            // Speed (4pc: +25% base), Revenge (4pc: +12% base), Reversal
            // (4pc: +15% base). They can't all be 4pc simultaneously on a
            // 6-slot build, but for a LOOSE bound we just add them all.
            return 0.25 * baseSpd + 0.12 * baseSpd + 0.15 * baseSpd;
        case 'cr':  return 3 * 12;   // Crit 6pc stack
        case 'cd':  return 60;       // Destruction 4pc
        case 'eff': return 3 * 20;   // Hit 6pc stack
        case 'res': return 3 * 20;   // Resist 6pc stack
        // Not used in v1 (no upper-bound for these), but included so callers
        // wanting the full picture can read them:
        case 'atk': return 0.45 * baseAtk;
        case 'hp':  return 3 * 0.20 * baseHp;  // Health 6pc stack
        case 'def': return 3 * 0.20 * baseDef; // Defense 6pc stack
        default: return 0;
    }
}

function heroBonusFor(bucket, hero) {
    if (!hero) return 0;
    switch (bucket) {
        case 'atk': return (hero.bonusAtk || 0) + (hero.aeiAtk || 0) + (hero.artifactAttack || 0);
        case 'hp':  return (hero.bonusHp  || 0) + (hero.aeiHp  || 0) + (hero.artifactHealth || 0);
        case 'def': return (hero.bonusDef || 0) + (hero.aeiDef || 0) + (hero.artifactDefense || 0);
        case 'spd': return (hero.bonusSpeed || 0) + (hero.aeiSpeed || 0);
        case 'cr':  return (hero.bonusCr  || 0) + (hero.aeiCr  || 0);
        case 'cd':  return (hero.bonusCd  || 0) + (hero.aeiCd  || 0);
        case 'eff': return (hero.bonusEff || 0) + (hero.aeiEff || 0);
        case 'res': return (hero.bonusRes || 0) + (hero.aeiRes || 0);
        default: return 0;
    }
}

function baseValueFor(bucket, baseStats) {
    switch (bucket) {
        case 'atk': return baseStats.atk || 0;
        case 'hp':  return baseStats.hp  || 0;
        case 'def': return baseStats.def || 0;
        case 'spd': return baseStats.spd || 0;
        case 'cr':  return baseStats.cr  || 0;
        case 'cd':  return baseStats.cd  || 0;
        case 'eff': return baseStats.eff || 0;
        case 'res': return baseStats.res || 0;
        default: return 0;
    }
}

function groupByGear(items) {
    const out = { Weapon: [], Helmet: [], Armor: [], Necklace: [], Ring: [], Boots: [] };
    for (const it of items) {
        if (out[it.gear]) out[it.gear].push(it);
    }
    return out;
}

function precomputeBestPerSlot(itemsBySlot, baseStats) {
    const buckets = LINEAR_BUCKETS; // we only consult this for linear buckets
    const out = {};
    for (const slot of GEAR_SLOTS) {
        out[slot] = {};
        for (const b of buckets) {
            let best = 0;
            const arr = itemsBySlot[slot] || [];
            for (const it of arr) {
                const c = contribution(it, b, baseStats);
                if (c > best) best = c;
            }
            out[slot][b] = best;
        }
    }
    return out;
}

// ---- The two rules ----

function passesSubstatRule(item, careSet, superBuckets, baseStats) {
    const subs = item.substats || [];
    let cared = 0;
    for (const sub of subs) {
        const bucket = SUBSTAT_TO_BUCKET[sub.type];
        if (bucket && careSet.has(bucket)) cared++;
    }
    if (cared >= 2) return true;
    // Super-bucket exception: any super bucket whose contribution from this
    // single item meets the threshold keeps the item alive.
    if (superBuckets && superBuckets.size > 0 && baseStats) {
        for (const bucket of superBuckets) {
            const threshold = SUPER_THRESHOLDS[bucket];
            if (threshold == null) continue;
            const c = contributionInThresholdUnits(item, bucket, baseStats);
            if (c >= threshold) return true;
        }
    }
    return false;
}

function passesUpperBoundForStat(item, bucket, ctx) {
    const minKey = MIN_LIMIT_FOR_BUCKET[bucket];
    const minLimit = ctx.params[minKey];
    if (!isMinLimitSet(minLimit)) return true;

    let upper = baseValueFor(bucket, ctx.baseStats);
    upper += heroBonusFor(bucket, ctx.hero);
    upper += maxSetBonusForBucket(bucket, ctx.baseStats);
    upper += contribution(item, bucket, ctx.baseStats);

    for (const slot of GEAR_SLOTS) {
        if (slot === item.gear) continue;
        const slotBest = (ctx.bestPerSlot[slot] && ctx.bestPerSlot[slot][bucket]) || 0;
        upper += slotBest;
    }

    return upper >= minLimit;
}

function passesUpperBoundRule(item, ctx) {
    for (const bucket of LINEAR_BUCKETS) {
        if (!passesUpperBoundForStat(item, bucket, ctx)) return false;
    }
    return true;
}

// ---- Entrypoint ----

function prune(items, params, heroResponse, options) {
    const mode = (options && options.mode != null) ? options.mode : MODE_ON;
    if (mode === MODE_OFF) {
        return {
            items: items,
            diagnostics: { mode: 'off', input: items.length, output: items.length },
        };
    }

    const hero = (heroResponse && heroResponse.hero) || null;
    const baseStats = (heroResponse && heroResponse.baseStats) || {};
    const heroId = hero ? hero.id : null;

    const { careSet, superBuckets } = computeCareSet(params);

    // No stats are "cared about" — running the prune would drop nearly
    // everything, but the user gave no signal of what they want. Bail.
    if (careSet.size === 0) {
        return {
            items,
            diagnostics: {
                mode: 'no-care-set',
                input: items.length,
                output: items.length,
                reason: 'No sliders > 0 and no min/max limits set; skipped.',
            },
        };
    }

    // Pass 1: substat care-count.
    const equippedByHero = [];
    const afterCareCount = [];
    let droppedByCareCount = 0;
    for (const item of items) {
        if (heroId && item.equippedById === heroId) {
            equippedByHero.push(item);
            continue;
        }
        if (passesSubstatRule(item, careSet, superBuckets, baseStats)) {
            afterCareCount.push(item);
        } else {
            droppedByCareCount++;
        }
    }

    // Recompute best-per-slot from survivors only, so the upper bound
    // doesn't credit items that were just pruned.
    const itemsBySlot = groupByGear(afterCareCount.concat(equippedByHero));
    const bestPerSlot = precomputeBestPerSlot(itemsBySlot, baseStats);
    const ctx = { params, hero, baseStats, bestPerSlot };

    // Pass 2: linear-stat upper bounds.
    const kept = [];
    let droppedByUpperBound = 0;
    for (const item of afterCareCount) {
        if (passesUpperBoundRule(item, ctx)) {
            kept.push(item);
        } else {
            droppedByUpperBound++;
        }
    }

    const finalItems = kept.concat(equippedByHero);

    const inputBySlot  = groupByGear(items);
    const outputBySlot = groupByGear(finalItems);
    const permsBefore = GEAR_SLOTS.reduce((acc, s) => acc * Math.max(1, (inputBySlot[s]  || []).length), 1);
    const permsAfter  = GEAR_SLOTS.reduce((acc, s) => acc * Math.max(1, (outputBySlot[s] || []).length), 1);

    const diagnostics = {
        mode: 'on',
        input: items.length,
        output: finalItems.length,
        droppedByCareCount,
        droppedByUpperBound,
        equippedBypass: equippedByHero.length,
        careSet: Array.from(careSet),
        superBuckets: Array.from(superBuckets),
        permsBefore,
        permsAfter,
        permsRatio: permsBefore > 0 ? permsAfter / permsBefore : 1,
        perSlot: GEAR_SLOTS.reduce((acc, s) => {
            acc[s] = {
                in:  (inputBySlot[s]  || []).length,
                out: (outputBySlot[s] || []).length,
            };
            return acc;
        }, {}),
    };

    return { items: finalItems, diagnostics };
}

module.exports = {
    prune,
    MODE_OFF,
    MODE_ON,
    MODE_ON_PLUS,
    // Exposed for tests / external callers wanting to introspect:
    _internal: {
        GEAR_SLOTS,
        LINEAR_BUCKETS,
        SUBSTAT_TO_BUCKET,
        computeCareSet,
        contribution,
        maxSetBonusForBucket,
        passesSubstatRule,
        passesUpperBoundForStat,
        groupByGear,
        precomputeBestPerSlot,
    },
};

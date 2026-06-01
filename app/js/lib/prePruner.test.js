// Lightweight smoke tests for prePruner.js.
//
// Run with:
//   export PATH="$HOME/.nvm/versions/node/v14.21.3/bin:$PATH"
//   node app/js/lib/prePruner.test.js
//
// No framework; assertions throw on failure and the harness reports
// pass/fail counts. Keep this file in sync with prePruner.js by hand.

const Pruner = require('./prePruner');

let passed = 0;
let failed = 0;

function assert(cond, label) {
    if (cond) {
        passed++;
        console.log('  \u2713', label);
    } else {
        failed++;
        console.log('  \u2717', label);
    }
}

function section(title, fn) {
    console.log('\n' + title);
    fn();
}

// --- Test fixtures ---

function makeHeroResponse(overrides) {
    const baseStats = Object.assign({
        atk: 1000, hp: 5000, def: 600,
        spd: 110, cr: 15, cd: 150, eff: 0, res: 0,
    }, (overrides && overrides.baseStats) || {});
    const hero = Object.assign({
        id: 'heroA',
        bonusAtk: 0, bonusHp: 0, bonusDef: 0, bonusSpeed: 0,
        bonusCr: 0, bonusCd: 0, bonusEff: 0, bonusRes: 0,
        aeiAtk: 0, aeiHp: 0, aeiDef: 0, aeiSpeed: 0,
        aeiCr: 0, aeiCd: 0, aeiEff: 0, aeiRes: 0,
        artifactAttack: 0, artifactHealth: 0, artifactDefense: 0,
    }, (overrides && overrides.hero) || {});
    return { hero, baseStats };
}

let nextId = 1;
function makeItem(gear, subs, opts) {
    const o = opts || {};
    const substats = subs.map(s => ({ type: s[0], value: s[1] }));
    const augmentedStats = { mainType: o.mainType || 'Attack', mainValue: o.mainValue || 0 };
    for (const sub of substats) augmentedStats[sub.type] = sub.value;
    return {
        id: 'item-' + (nextId++),
        gear,
        set: 0,
        enhance: 15,
        equippedById: o.equippedById || null,
        substats,
        augmentedStats,
        main: { type: o.mainType || 'Attack', value: o.mainValue || 100 },
    };
}

function emptyParams() {
    return {
        inputAtkPriority: 0, inputHpPriority: 0, inputDefPriority: 0, inputSpdPriority: 0,
        inputCrPriority: 0, inputCdPriority: 0, inputEffPriority: 0, inputResPriority: 0,
    };
}

// --- Tests ---

section('computeCareSet', () => {
    const { computeCareSet } = Pruner._internal;
    {
        const p = emptyParams();
        const { careSet, superBuckets } = computeCareSet(p);
        assert(careSet.size === 0, 'empty params produce empty careSet');
        assert(superBuckets.size === 0, 'empty params produce empty superBuckets');
    }
    {
        const p = emptyParams();
        p.inputSpdPriority = 3;
        p.inputCrPriority = 1;
        p.inputAtkMinLimit = 3500;
        const { careSet, superBuckets } = computeCareSet(p);
        assert(careSet.has('spd'), 'spd in careSet (slider > 0)');
        assert(careSet.has('cr'), 'cr in careSet (slider > 0)');
        assert(careSet.has('atk'), 'atk in careSet (min limit)');
        assert(!careSet.has('hp'), 'hp not in careSet');
        assert(superBuckets.size === 0, 'no slider at 4 → no superBuckets');
    }
    {
        // Slider at the super value (4) → that bucket is a superBucket.
        const p = emptyParams();
        p.inputSpdPriority = 4;
        const { careSet, superBuckets } = computeCareSet(p);
        assert(careSet.has('spd'), 'spd in careSet (slider == 4)');
        assert(superBuckets.has('spd') && superBuckets.size === 1,
            'spd in superBuckets (slider == 4)');
    }
    {
        // Multiple sliders at 4 → multiple superBuckets.
        const p = emptyParams();
        p.inputSpdPriority = 4;
        p.inputCrPriority = 4;
        const { superBuckets } = computeCareSet(p);
        assert(superBuckets.has('spd') && superBuckets.has('cr'),
            'multiple sliders at 4 → multiple superBuckets');
    }
    {
        // Slider at 3 is NOT a super bucket.
        const p = emptyParams();
        p.inputSpdPriority = 3;
        const { superBuckets } = computeCareSet(p);
        assert(!superBuckets.has('spd'),
            'slider at 3 is not a super bucket (super requires 4)');
    }
    {
        const p = emptyParams();
        p.inputAtkPriority = -1;
        const { careSet } = computeCareSet(p);
        assert(!careSet.has('atk'), 'negative slider does not put stat in careSet');
    }
    {
        const p = emptyParams();
        p.inputHpMaxLimit = 30000;
        const { careSet } = computeCareSet(p);
        assert(careSet.has('hp'), 'max limit alone puts stat in careSet');
    }
});

section('passesSubstatRule', () => {
    const { passesSubstatRule } = Pruner._internal;
    const careSet = new Set(['spd', 'cr']);
    const noSupers = new Set();
    const baseStats = { atk: 1000, hp: 5000, def: 600, spd: 100 };

    const allUncared = makeItem('Boots', [
        ['Attack', 10], ['HealthPercent', 5], ['Defense', 20], ['EffectivenessPercent', 8],
    ]);
    assert(!passesSubstatRule(allUncared, careSet, noSupers, baseStats),
        'n_cared==0 → drop');

    const oneCared = makeItem('Boots', [
        ['Attack', 10], ['HealthPercent', 5], ['Defense', 20], ['CriticalHitChancePercent', 8],
    ]);
    assert(!passesSubstatRule(oneCared, careSet, noSupers, baseStats),
        'n_cared==1 with no super bucket → drop');

    const twoCared = makeItem('Boots', [
        ['Speed', 5], ['CriticalHitChancePercent', 8], ['HealthPercent', 5], ['Attack', 10],
    ]);
    assert(passesSubstatRule(twoCared, careSet, noSupers, baseStats),
        'n_cared==2 → keep');
});

section('super-bucket exception', () => {
    const { passesSubstatRule } = Pruner._internal;
    const careSet = new Set(['spd']);
    const superBuckets = new Set(['spd']);
    const baseStats = { atk: 1000, hp: 5000, def: 600, spd: 100 };

    // Big SPD sub (18) > threshold 16, only 1 cared sub → keep via super.
    const bigSpdSub = makeItem('Boots', [
        ['Speed', 18], ['Attack', 10], ['HealthPercent', 5], ['Defense', 20],
    ]);
    assert(passesSubstatRule(bigSpdSub, careSet, superBuckets, baseStats),
        'single large SPD sub (>=16) bypasses n_cared via super exception');

    // Small SPD sub (5) < threshold, 1 cared → drop.
    const smallSpdSub = makeItem('Boots', [
        ['Speed', 5], ['Attack', 10], ['HealthPercent', 5], ['Defense', 20],
    ]);
    assert(!passesSubstatRule(smallSpdSub, careSet, superBuckets, baseStats),
        'small SPD contribution does not trigger super exception');

    // SPD main on boots (+25 main) easily clears threshold even with 0 SPD subs.
    const spdMain = makeItem('Boots', [
        ['Attack', 10], ['HealthPercent', 5], ['Defense', 20], ['EffectivenessPercent', 8],
    ], { mainType: 'Speed', mainValue: 25 });
    assert(passesSubstatRule(spdMain, careSet, superBuckets, baseStats),
        'SPD main alone clears super threshold');

    // ATK %-of-base test: base 1000, threshold 35% → need 350 raw atk
    // contribution. AttackPercent main of 8% on weapon → 80 raw, plus subs
    // need to fill. A fat AttackPercent sub of 30% → 300 raw, plus 80 main
    // = 380 → over 35%.
    const atkSupers = new Set(['atk']);
    const atkCare = new Set(['atk']);
    const heavyAtk = makeItem('Weapon', [
        ['AttackPercent', 30], ['HealthPercent', 5], ['Defense', 20], ['EffectivenessPercent', 8],
    ], { mainType: 'AttackPercent', mainValue: 8 });
    assert(passesSubstatRule(heavyAtk, atkCare, atkSupers, baseStats),
        'large ATK% contribution (>=35% of base) triggers ATK super exception');

    const lightAtk = makeItem('Weapon', [
        ['AttackPercent', 4], ['HealthPercent', 5], ['Defense', 20], ['EffectivenessPercent', 8],
    ], { mainType: 'Attack', mainValue: 50 });
    assert(!passesSubstatRule(lightAtk, atkCare, atkSupers, baseStats),
        'small ATK contribution does not trigger ATK super exception');
});

section('upper bound: speed example (the 220 SPD scenario)', () => {
    const heroResp = makeHeroResponse({ baseStats: { spd: 100 } });
    const params = emptyParams();
    params.inputSpdPriority = 3;
    params.inputSpdMinLimit = 220;

    // Build a pool where every item has at most 4 SPD on subs and 0 SPD main.
    // Best-case build: 6 × 4 SPD = 24, plus base 100, plus loose set
    // bonus = 0.25*100 + 0.12*100 + 0.15*100 = 52. Total upper = 100 + 24 + 52 = 176.
    // 176 < 220 → every item should be dropped by upper bound.
    const items = [];
    for (const slot of Pruner._internal.GEAR_SLOTS) {
        for (let i = 0; i < 3; i++) {
            items.push(makeItem(slot, [
                ['Speed', 4], ['Speed', 0], ['Attack', 10], ['HealthPercent', 5],
            ], { mainType: 'Attack', mainValue: 100 }));
        }
    }
    const result = Pruner.prune(items, params, heroResp, { mode: Pruner.MODE_ON });
    assert(result.items.length === 0,
        `unreachable SPD target drops everything (got ${result.items.length}/${items.length})`);
    assert(result.diagnostics.droppedByUpperBound > 0,
        'drops attributed to upper-bound rule');
});

section('upper bound: achievable target keeps everything', () => {
    const heroResp = makeHeroResponse({ baseStats: { spd: 100 } });
    const params = emptyParams();
    params.inputSpdPriority = 3;
    params.inputCrPriority = 3; // give items 2 cared subs under the new rule
    params.inputSpdMinLimit = 150; // easily reachable

    const items = [];
    for (const slot of Pruner._internal.GEAR_SLOTS) {
        for (let i = 0; i < 2; i++) {
            items.push(makeItem(slot, [
                ['Speed', 5], ['CriticalHitChancePercent', 6], ['Health', 50], ['Attack', 10],
            ]));
        }
    }
    const result = Pruner.prune(items, params, heroResp, { mode: Pruner.MODE_ON });
    assert(result.items.length === items.length,
        `achievable SPD target keeps everything (got ${result.items.length}/${items.length})`);
});

section('equipped-by-hero bypass', () => {
    const heroResp = makeHeroResponse();
    const params = emptyParams();
    params.inputSpdPriority = 3;
    params.inputSpdMinLimit = 999999; // impossible -> everything would drop

    const itemsPool = [];
    for (const slot of Pruner._internal.GEAR_SLOTS) {
        itemsPool.push(makeItem(slot, [
            ['Attack', 10], ['HealthPercent', 5], ['Defense', 20], ['EffectivenessPercent', 8],
        ], { equippedById: 'heroA' }));
    }
    const result = Pruner.prune(itemsPool, params, heroResp, { mode: Pruner.MODE_ON });
    assert(result.items.length === itemsPool.length,
        'items equipped by target hero bypass both rules');
});

section('MODE_OFF passes everything through', () => {
    const heroResp = makeHeroResponse();
    const params = emptyParams();
    params.inputSpdMinLimit = 999999;
    const items = [
        makeItem('Boots', [['Attack', 10], ['HealthPercent', 5], ['Defense', 20], ['EffectivenessPercent', 8]]),
    ];
    const result = Pruner.prune(items, params, heroResp, { mode: Pruner.MODE_OFF });
    assert(result.items.length === 1, 'MODE_OFF leaves items untouched');
    assert(result.diagnostics.mode === 'off', 'diagnostics report off mode');
});

section('empty careSet bails out (does not over-prune)', () => {
    const heroResp = makeHeroResponse();
    const params = emptyParams(); // no sliders, no limits
    const items = [
        makeItem('Boots', [['Attack', 10], ['Health', 50], ['Defense', 20], ['Speed', 5]]),
    ];
    const result = Pruner.prune(items, params, heroResp, { mode: Pruner.MODE_ON });
    assert(result.items.length === 1, 'empty careSet → no pruning');
    assert(result.diagnostics.mode === 'no-care-set', 'diagnostics flag no-care-set');
});

section('diagnostics include per-slot counts and perm ratio', () => {
    const heroResp = makeHeroResponse({ baseStats: { spd: 100 } });
    const params = emptyParams();
    params.inputSpdPriority = 3;
    params.inputSpdMinLimit = 130;

    const items = [];
    for (const slot of Pruner._internal.GEAR_SLOTS) {
        items.push(makeItem(slot, [
            ['Speed', 4], ['CriticalHitChancePercent', 6], ['Health', 50], ['Attack', 10],
        ]));
        items.push(makeItem(slot, [
            ['Attack', 10], ['HealthPercent', 5], ['Defense', 20], ['EffectivenessPercent', 8],
        ]));
    }
    const result = Pruner.prune(items, params, heroResp, { mode: Pruner.MODE_ON });
    assert(typeof result.diagnostics.permsBefore === 'number',
        'permsBefore present');
    assert(typeof result.diagnostics.permsAfter === 'number',
        'permsAfter present');
    assert(result.diagnostics.permsAfter <= result.diagnostics.permsBefore,
        'permsAfter <= permsBefore');
    assert(result.diagnostics.perSlot.Boots && typeof result.diagnostics.perSlot.Boots.in === 'number',
        'perSlot counts present');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

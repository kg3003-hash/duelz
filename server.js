#!/usr/bin/env node
/* =============================================================================
   DAD DISCORD DUELS — Authoritative Game Server
   ZERO dependencies: run with just `node server.js` (Node 16+).
   - Implements the WebSocket protocol (RFC 6455) directly on node builtins
   - Embeds the game's own simulation + bot AI (generated from game.html —
     regenerate with build_server.py after sim changes, do not hand-edit those
     sections)
   - Server-authoritative: 30Hz simulation, 20Hz state broadcast, per-room
   - PORT env var (default 8080). Put TLS in front (Railway/Render/cloudflared
     provide wss:// automatically) — browsers on https pages REQUIRE wss://.
   ============================================================================= */
'use strict';
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const TICK_MS = 33;            // 30Hz simulation
const BROADCAST_MS = 50;       // 20Hz state stream
const ROOM_IDLE_TTL = 120000;  // empty rooms die after 2 min
const DISCONNECT_GRACE = 30000;
const MAX_MSG = 32 * 1024;

/* ======== EMBEDDED GAME SIMULATION (generated from game.html) ======== */
// ===== CLASS & ABILITY DATA =====
const MELEE = 70, R8=160, R10=200, R15=300, R20=400, R25=500, R30=600;

const CLASS_DATA = {
  warrior: { name:'Warrior', resource:'rage', maxResource:100, maxHp:105, color:'#C79C6E', icon:'⚔️',
    autoAttack: { damage:7, interval:1.5, rageGain:8, fxColor:'#C79C6E' },
    abilities:[
      { id:'charge', name:'Charge', cost:0, rageGain:20, cooldown:12, castTime:0, range:R15, kind:'gapcloser', damage:10, stun:1, dashSpeed:900, needsTarget:'enemy', fxKind:'melee', fxColor:'#ffaa55', desc:'Dash to an enemy up to 15 yd away: 10 dmg, 1s stun, builds 20 rage. 12s cooldown. Cannot be used while rooted.' },
      { id:'slam', name:'Slam', cost:30, rageGain:10, cooldown:1.5, castTime:0, range:MELEE, kind:'melee', damage:26, needsTarget:'enemy', fxKind:'melee', fxColor:'#ff6644', desc:'Melee strike for 26 dmg. Requires melee range.' },
      { id:'shieldblock', name:'Shield Block', cost:20, cooldown:15, castTime:0, range:0, kind:'selfbuff', duration:3, damageReduction:0.5, needsTarget:'none', fxKind:'shield', fxColor:'#ffd700', desc:'Reduce damage taken by 50% for 3s.' },
      { id:'rallyingcry', name:'Rallying Cry', cost:40, cooldown:45, castTime:0, range:0, kind:'teambuff', duration:6, hpBuffPct:0.12, needsTarget:'none', fxKind:'buff', fxColor:'#ffaa00', desc:'You and your allies gain 12% bonus max HP for 6s.' },
    ],
    unlocks:[
      { id:'hamstring', name:'Hamstring', unlockLevel:2, cost:15, cooldown:6, castTime:0, range:MELEE, kind:'melee', damage:8, slow:{amount:0.5,duration:4}, needsTarget:'enemy', fxKind:'melee', fxColor:'#cc7744', desc:'8 dmg + slow 50% for 4s. The melee answer to kiting.' },
      { id:'execute', name:'Execute', unlockLevel:4, cost:25, cooldown:8, castTime:0, range:MELEE, kind:'melee', damage:18, executeDamage:44, executeThreshold:0.3, needsTarget:'enemy', fxKind:'melee', fxColor:'#ff3322', desc:'18 dmg (44 if target below 30% HP).' },
      { id:'thunderclap', name:'Thunder Clap', unlockLevel:6, cost:25, cooldown:12, castTime:0, range:0, kind:'shockwave', radius:140, damage:14, slow:{amount:0.4,duration:3}, needsTarget:'none', fxKind:'aoe', fxColor:'#88aaff', desc:'14 dmg + 40% slow for 3s to all enemies within 7 yd of you.' },
      { id:'pummel', name:'Pummel', unlockLevel:8, cost:10, cooldown:14, castTime:0, range:MELEE, kind:'interrupt', lockout:3, needsTarget:'enemy', fxKind:'cc', fxColor:'#ffaa55', desc:'Interrupt the target\'s spellcast, silencing them for 3s. Melee range.' },
      { id:'bladestorm', name:'Bladestorm', unlockLevel:10, cost:30, cooldown:45, castTime:0, range:0, kind:'ccimmune', duration:4, needsTarget:'none', fxKind:'buff', fxColor:'#ff8a2e', desc:'Break free of ALL crowd control and become immune to it for 4s.' },
    ]},
  rogue: { name:'Rogue', resource:'energy', maxResource:100, maxHp:82, color:'#FFF569', icon:'🗡️',
    autoAttack: { damage:5, interval:1.0, fxColor:'#FFF569' },
    abilities:[
      { id:'backstab', name:'Backstab', cost:40, cooldown:1.5, castTime:0, range:MELEE, kind:'melee', damage:30, executeDamage:42, executeThreshold:0.3, needsTarget:'enemy', fxKind:'melee', fxColor:'#fff569', desc:'30 dmg (42 if target below 30% HP). Requires melee range.' },
      { id:'shadowstep', name:'Shadowstep', cost:25, cooldown:26, castTime:0, range:R25, kind:'shadowstep', needsTarget:'enemy', fxKind:'utility', fxColor:'#b48cff', desc:'Teleport behind your target (up to 25 yd).' },
      { id:'vanish', name:'Vanish', cost:30, cooldown:20, castTime:0, range:0, kind:'vanish', duration:2, needsTarget:'none', fxKind:'utility', fxColor:'#ffff88', desc:'Untargetable 2s, clears stuns/roots.' },
      { id:'cheapshot', name:'Cheap Shot', cost:40, cooldown:22, castTime:0, range:MELEE, kind:'melee', damage:8, stun:2, needsTarget:'enemy', fxKind:'cc', fxColor:'#ffee66', desc:'8 dmg + stun 2s. Requires melee range.' },
    ],
    unlocks:[
      { id:'sprint', name:'Sprint', unlockLevel:2, cost:20, cooldown:20, castTime:0, range:0, kind:'speedbuff', mult:1.6, duration:4, needsTarget:'none', fxKind:'utility', fxColor:'#5ee0ff', desc:'Move 60% faster for 4s.' },
      { id:'shiv', name:'Shiv', unlockLevel:4, cost:20, cooldown:8, castTime:0, range:MELEE, kind:'melee', damage:10, slow:{amount:0.7,duration:3}, needsTarget:'enemy', fxKind:'melee', fxColor:'#7cff5a', desc:'10 dmg + crippling 70% slow for 3s.' },
      { id:'kick', name:'Kick', unlockLevel:6, cost:15, cooldown:12, castTime:0, range:MELEE, kind:'interrupt', lockout:3, needsTarget:'enemy', fxKind:'cc', fxColor:'#fff569', desc:'Interrupt the target\'s spellcast, silencing them for 3s. Melee range.' },
      { id:'eviscerate', name:'Eviscerate', unlockLevel:8, cost:35, cooldown:10, castTime:0, range:MELEE, kind:'melee', damage:24, executeDamage:40, executeThreshold:0.35, needsTarget:'enemy', fxKind:'melee', fxColor:'#ff5566', desc:'24 dmg (40 if target below 35% HP).' },
      { id:'poisonstrike', name:'Poison Strike', unlockLevel:10, cost:25, cooldown:6, castTime:0, range:MELEE, kind:'melee', damage:12, dot:{ total:30, duration:6 }, needsTarget:'enemy', fxKind:'dot', fxColor:'#7cff5a', desc:'12 dmg + poison (30 over 6s). Requires melee range.' },
    ]},
  mage: { name:'Mage', resource:'mana', maxResource:100, maxHp:92, color:'#69CCF0', icon:'🔮',
    abilities:[
      { id:'frostbolt', name:'Frostbolt', cost:18, cooldown:0, castTime:1.2, range:R20, kind:'ranged', damage:26, projectileSpeed:620, slow:{ amount:0.6, duration:4 }, needsTarget:'enemy', fxKind:'bolt', fxColor:'#69ccf0', desc:'26 dmg + slow 60% for 4s.' },
      { id:'counterspell', name:'Counterspell', cost:20, cooldown:24, castTime:0, range:R20, kind:'interrupt', lockout:4, needsTarget:'enemy', fxKind:'cc', fxColor:'#4db8ff', desc:'Interrupt the target\'s spellcast and silence them for 4s. Wasted if they aren\'t casting.' },
      { id:'blink', name:'Blink', cost:15, cooldown:14, castTime:0, range:0, kind:'blink', distance:200, needsTarget:'none', fxKind:'utility', fxColor:'#69ccf0', desc:'Teleport 10 yd in the direction you are moving (or facing, if still).' },
      { id:'frostnova', name:'Frost Nova', cost:20, cooldown:12, castTime:0, range:0, kind:'nova', radius:150, rootDuration:3, needsTarget:'none', fxKind:'nova', fxColor:'#7fdbff', desc:'Instantly freeze all enemies within 7.5 yd in place for 3s.' },
    ],
    unlocks:[
      { id:'fireblast', name:'Fire Blast', unlockLevel:2, cost:20, cooldown:8, castTime:0, range:R15, kind:'ranged', damage:18, projectileSpeed:900, needsTarget:'enemy', fxKind:'bolt', fxColor:'#ff6a2e', desc:'Instant 18 dmg fireball.' },
      { id:'arcanebarrage', name:'Arcane Barrage', unlockLevel:4, cost:28, cooldown:6, castTime:1.5, range:R20, kind:'ranged', damage:32, projectileSpeed:700, needsTarget:'enemy', fxKind:'bolt', fxColor:'#cc88ff', desc:'32 dmg arcane missile. 1.5s cast.' },
      { id:'icebarrier', name:'Ice Barrier', unlockLevel:6, cost:30, cooldown:25, castTime:0, range:0, kind:'selfshield', shield:50, duration:8, needsTarget:'none', fxKind:'shield', fxColor:'#7fdbff', desc:'Absorb 50 damage for 8s.' },
      { id:'deepfreeze', name:'Deep Freeze', unlockLevel:8, cost:25, cooldown:22, castTime:0, range:R15, kind:'stunonly', stun:2, needsTarget:'enemy', fxKind:'cc', fxColor:'#7fdbff', desc:'Stun the target for 2s.' },
      { id:'meteor', name:'Meteor', unlockLevel:10, cost:35, cooldown:20, castTime:1.5, range:R20, kind:'targetaoe', radius:120, damage:34, needsTarget:'enemy', fxKind:'aoe', fxColor:'#ff8844', desc:'34 dmg to all enemies within 6 yd of the target. 1.5s cast.' },
    ]},
  priest: { name:'Priest', resource:'mana', maxResource:100, maxHp:85, color:'#FFFFFF', icon:'✨',
    abilities:[
      { id:'heal', name:'Heal', cost:40, cooldown:0, castTime:1.7, range:R25, kind:'heal', amount:56, needsTarget:'ally', fxKind:'heal', fxColor:'#ffffff', desc:'Heal an ally (or yourself) for 56.' },
      { id:'smite', name:'Smite', cost:20, cooldown:0, castTime:1.2, range:R20, kind:'ranged', damage:31, projectileSpeed:620, needsTarget:'enemy', fxKind:'bolt', fxColor:'#ffe9a8', desc:'31 dmg holy bolt. 1.2s cast.' },
      { id:'powershield', name:'Power Shield', cost:25, cooldown:12, castTime:0, range:R25, kind:'shield', shield:48, duration:10, needsTarget:'allyorself', fxKind:'shield', fxColor:'#ffffff', desc:'Shield an ally: absorb 48, 10s.' },
      { id:'fear', name:'Fear', cost:35, cooldown:20, castTime:0, range:R15, kind:'fear', duration:4, needsTarget:'enemy', fxKind:'cc', fxColor:'#b48cff', desc:'Target flees randomly, cannot act, 4s.' },
    ],
    unlocks:[
      { id:'renew', name:'Renew', unlockLevel:2, cost:25, cooldown:6, castTime:0, range:R25, kind:'hot', hotTotal:36, hotDuration:9, needsTarget:'allyorself', fxKind:'heal', fxColor:'#aaffcc', desc:'Heal an ally for 36 over 9s. Instant.' },
      { id:'mindblast', name:'Mind Blast', unlockLevel:4, cost:28, cooldown:8, castTime:1.2, range:R20, kind:'ranged', damage:30, projectileSpeed:700, needsTarget:'enemy', fxKind:'bolt', fxColor:'#c0a8ff', desc:'30 dmg psychic blast. 1.2s cast.' },
      { id:'psilence', name:'Silence', unlockLevel:6, cost:30, cooldown:20, castTime:0, range:R15, kind:'silence', duration:3, needsTarget:'enemy', fxKind:'cc', fxColor:'#8866cc', desc:'Silence the target for 3s.' },
      { id:'flashheal', name:'Flash Heal', unlockLevel:8, cost:32, cooldown:0, castTime:1, range:R25, kind:'heal', amount:32, needsTarget:'allyorself', fxKind:'heal', fxColor:'#ffffff', desc:'Fast 1s-cast heal for 32. Expensive.' },
      { id:'divinehymn', name:'Divine Hymn', unlockLevel:10, cost:45, cooldown:30, castTime:0, range:0, kind:'aoeheal', amount:30, needsTarget:'none', fxKind:'heal', fxColor:'#ffe9a8', desc:'Instantly heal yourself and all allies for 30.' },
    ]},
  hunter: { name:'Hunter', resource:'mana', maxResource:100, maxHp:95, color:'#ABD473', icon:'🏹',
    autoAttack: { damage:6, interval:1.5, range:R15, fxKind:'arrow', fxColor:'#d8e8b8', noAutoAttackAnim:true },
    abilities:[
      { id:'aimedshot', name:'Aimed Shot', cost:30, cooldown:0, castTime:1.5, range:R25, kind:'ranged', damage:44, projectileSpeed:900, needsTarget:'enemy', fxKind:'bolt', fxColor:'#abd473', desc:'44 dmg sniper shot from long range. 1.5s cast.' },
      { id:'frosttrap', name:'Frost Trap', cost:20, cooldown:15, castTime:0, range:0, kind:'trap', duration:10, rootDuration:4, needsTarget:'none', fxKind:'trap', fxColor:'#7fd1ff', desc:'Place a frost trap at your feet: the first enemy to step on it is frozen in place for 4s. Lasts 10s.' },
      { id:'disengage', name:'Disengage', cost:15, cooldown:18, castTime:0, range:0, kind:'disengage', distance:200, needsTarget:'none', fxKind:'utility', fxColor:'#abd473', desc:'Leap away from nearest enemy.' },
      { id:'multishot', name:'Multi-Shot', cost:25, cooldown:6, castTime:0, range:R25, kind:'cone', damage:20, coneAngle:60, needsTarget:'none', fxKind:'aoe', fxColor:'#abd473', desc:'20 dmg to all enemies in a cone.' },
    ],
    unlocks:[
      { id:'concussiveshot', name:'Concussive Shot', unlockLevel:2, cost:15, cooldown:8, castTime:0, range:R20, kind:'ranged', damage:8, projectileSpeed:900, slow:{amount:0.5,duration:4}, needsTarget:'enemy', fxKind:'arrow', fxColor:'#abd473', desc:'Instant 8 dmg + 50% slow for 4s.' },
      { id:'serpentsting', name:'Serpent Sting', unlockLevel:4, cost:20, cooldown:6, castTime:0, range:R20, kind:'dotonly', dot:{ total:45, duration:9 }, needsTarget:'enemy', fxKind:'dot', fxColor:'#7cff5a', desc:'Poison: 45 dmg over 9s.' },
      { id:'countershot', name:'Counter Shot', unlockLevel:6, cost:15, cooldown:16, castTime:0, range:R20, kind:'interrupt', lockout:3, needsTarget:'enemy', fxKind:'cc', fxColor:'#abd473', desc:'Interrupt the target\'s spellcast, silencing them for 3s.' },
      { id:'killshot', name:'Kill Shot', unlockLevel:8, cost:25, cooldown:10, castTime:0, range:R20, kind:'ranged', damage:22, executeDamage:48, executeThreshold:0.3, projectileSpeed:900, needsTarget:'enemy', fxKind:'arrow', fxColor:'#ff5533', desc:'22 dmg (48 if target below 30% HP). Instant.' },
      { id:'rapidfire', name:'Rapid Fire', unlockLevel:10, cost:30, cooldown:30, castTime:0, range:0, kind:'autohaste', duration:6, needsTarget:'none', fxKind:'buff', fxColor:'#abd473', desc:'Auto-shots fire twice as fast for 6s.' },
    ]},
  warlock: { name:'Warlock', resource:'mana', maxResource:100, maxHp:85, color:'#9482C9', icon:'💀',
    abilities:[
      { id:'shadowbolt', name:'Shadow Bolt', cost:25, cooldown:0, castTime:1.2, range:R25, kind:'ranged', damage:30, projectileSpeed:620, needsTarget:'enemy', fxKind:'bolt', fxColor:'#9482C9', desc:'30 dmg shadow bolt. 1.2s cast.' },
      { id:'corruption', name:'Corruption', cost:20, cooldown:4, castTime:0, range:R25, kind:'dotonly', dot:{ total:60, duration:9 }, needsTarget:'enemy', fxKind:'dot', fxColor:'#6a4a9c', desc:'Corrupt the target: 60 dmg over 9s.' },
      { id:'drainlife', name:'Drain Life', cost:30, cooldown:10, castTime:0, range:R15, kind:'channel', channelDuration:3, damagePerSec:10, healPerSec:14, needsTarget:'enemy', fxKind:'dot', fxColor:'#9482C9', desc:'Channel 3s: 10 dmg/s to target, 14 heal/s to self.' },
      { id:'banish', name:'Banish', cost:35, cooldown:20, castTime:0, range:R20, kind:'banish', duration:4, needsTarget:'enemy', fxKind:'cc', fxColor:'#3a2a5c', desc:'Silence + root target for 4s.' },
    ],
    unlocks:[
      { id:'agony', name:'Agony', unlockLevel:2, cost:18, cooldown:8, castTime:0, range:R25, kind:'dotonly', dot:{ total:40, duration:10 }, needsTarget:'enemy', fxKind:'dot', fxColor:'#aa4488', desc:'Curse: 40 dmg over 10s. Stacks with Corruption.' },
      { id:'howlofterror', name:'Howl of Terror', unlockLevel:4, cost:30, cooldown:24, castTime:0, range:160, kind:'fear', duration:3, needsTarget:'enemy', fxKind:'cc', fxColor:'#b48cff', desc:'Terrify a nearby enemy (8 yd): they flee for 3s.' },
      { id:'shadowfury', name:'Shadowfury', unlockLevel:6, cost:30, cooldown:25, castTime:0, range:R20, kind:'targetaoe', radius:110, stun:1.5, needsTarget:'enemy', fxKind:'cc', fxColor:'#3a2a5c', desc:'Stun all enemies within 5.5 yd of the target for 1.5s.' },
      { id:'darkpact', name:'Dark Pact', unlockLevel:8, cost:15, cooldown:20, castTime:0, range:0, kind:'heal', amount:30, needsTarget:'allyorself', fxKind:'heal', fxColor:'#9482C9', desc:'Sacrifice shadow essence to heal yourself for 30. Instant.' },
      { id:'chaosbolt', name:'Chaos Bolt', unlockLevel:10, cost:35, cooldown:10, castTime:2, range:R20, kind:'ranged', damage:46, projectileSpeed:620, needsTarget:'enemy', fxKind:'bolt', fxColor:'#ff44aa', desc:'46 dmg of pure chaos. 2s cast — protect it.' },
    ]},
  paladin: { name:'Paladin', resource:'mana', maxResource:100, maxHp:120, color:'#F58CBA', icon:'🛡️',
    autoAttack: { damage:4, interval:2.0, fxColor:'#F58CBA' },
    abilities:[
      { id:'holystrike', name:'Holy Strike', cost:25, cooldown:1.5, castTime:0, range:MELEE, kind:'melee', damage:24, needsTarget:'enemy', fxKind:'melee', fxColor:'#F58CBA', desc:'24 dmg melee strike. Requires melee range.' },
      { id:'holylight', name:'Holy Light', cost:40, cooldown:0, castTime:2, range:R25, kind:'heal', amount:38, needsTarget:'allyorself', fxKind:'heal', fxColor:'#ffe9a8', desc:'Heal an ally (or yourself) for 38. 2s cast — can be interrupted.' },
      { id:'divineshield', name:'Divine Shield', cost:20, cooldown:60, castTime:0, range:0, kind:'immune', duration:1.7, needsTarget:'none', fxKind:'shield', fxColor:'#ffffff', desc:'Immune to all damage for 1.7s.' },
      { id:'hammerofjustice', name:'Hammer of Justice', cost:25, cooldown:15, castTime:0, range:R10, kind:'stunonly', stun:2, needsTarget:'enemy', fxKind:'cc', fxColor:'#F58CBA', desc:'Stun target for 2s.' },
    ],
    unlocks:[
      { id:'judgment', name:'Judgment', unlockLevel:2, cost:18, cooldown:8, castTime:0, range:R15, kind:'ranged', damage:18, projectileSpeed:800, needsTarget:'enemy', fxKind:'bolt', fxColor:'#ffe9a8', desc:'Instant 18 dmg holy strike from range.' },
      { id:'freedom', name:'Blessing of Freedom', unlockLevel:4, cost:20, cooldown:25, castTime:0, range:R25, kind:'freedom', duration:5, needsTarget:'allyorself', fxKind:'buff', fxColor:'#ffe9a8', desc:'Free an ally (or yourself) from roots and slows, and prevent them for 5s.' },
      { id:'repentance', name:'Repentance', unlockLevel:6, cost:30, cooldown:25, castTime:0, range:R15, kind:'banish', duration:3, needsTarget:'enemy', fxKind:'cc', fxColor:'#F58CBA', desc:'Force the target into penance: silenced and rooted for 3s.' },
      { id:'crusaderstrike', name:'Crusader Strike', unlockLevel:8, cost:18, cooldown:4, castTime:0, range:MELEE, kind:'melee', damage:20, selfHeal:10, needsTarget:'enemy', fxKind:'melee', fxColor:'#ffd700', desc:'20 dmg melee strike that heals you for 10.' },
      { id:'avengingwrath', name:'Avenging Wrath', unlockLevel:10, cost:30, cooldown:45, castTime:0, range:0, kind:'dmgbuff', mult:1.3, duration:8, needsTarget:'none', fxKind:'buff', fxColor:'#ffd700', desc:'Wings out: +30% damage dealt for 8s.' },
    ]},
  shaman: { name:'Shaman', resource:'mana', maxResource:100, maxHp:95, color:'#0070DE', icon:'🌩️',
    // Melee-only auto-attack (was ranged 250): shaman was tracking high on the
    // 2v2 balance watch list, and free ranged chip damage while kiting was part
    // of why. Losing it while repositioning is a real, felt tradeoff.
    autoAttack: { damage:5, interval:1.8, fxKind:'bolt', fxColor:'#6db8ff' },
    abilities:[
      { id:'lightningbolt', name:'Lightning Bolt', cost:25, cooldown:0, castTime:1.2, range:R25, kind:'ranged', damage:32, needsTarget:'enemy', fxKind:'bolt', fxColor:'#0070DE', desc:'32 dmg lightning bolt. 1.2s cast, instant strike.' },
      { id:'chainheal', name:'Chain Heal', cost:40, cooldown:0, castTime:2, range:R25, kind:'chainheal', amount:42, secondaryAmount:12, secondaryRange:250, needsTarget:'allyorself', fxKind:'heal', fxColor:'#55ff99', desc:'Heal target 42, then jumps to the most injured nearby ally for 12. 2s cast.' },
      { id:'earthshield', name:'Earth Shield', cost:25, cooldown:15, castTime:0, range:R25, kind:'shield', shield:60, duration:10, needsTarget:'allyorself', fxKind:'shield', fxColor:'#0070DE', desc:'Shield an ally: absorb 60 damage, lasts 10s.' },
      { id:'hex', name:'Hex', cost:35, cooldown:22, castTime:0, range:R20, kind:'hex', duration:4, slowAmount:0.6, needsTarget:'enemy', fxKind:'cc', fxColor:'#7a5230', desc:'Hex the target: silenced and slowed by 60% for 4s.' },
    ],
    unlocks:[
      { id:'earthshock', name:'Earth Shock', unlockLevel:2, cost:18, cooldown:8, castTime:0, range:R15, kind:'ranged', damage:16, projectileSpeed:850, needsTarget:'enemy', fxKind:'bolt', fxColor:'#c8a058', desc:'Instant 16 dmg shock.' },
      { id:'riptide', name:'Riptide', unlockLevel:4, cost:28, cooldown:8, castTime:0, range:R25, kind:'hot', amount:14, hotTotal:24, hotDuration:8, needsTarget:'allyorself', fxKind:'heal', fxColor:'#55ffcc', desc:'Instantly heal 14, then 24 more over 8s.' },
      { id:'windshear', name:'Wind Shear', unlockLevel:6, cost:12, cooldown:12, castTime:0, range:R20, kind:'interrupt', lockout:3, needsTarget:'enemy', fxKind:'cc', fxColor:'#8fd8ff', desc:'Interrupt the target\'s spellcast, silencing them for 3s. Cheap and fast.' },
      { id:'frostshock', name:'Frost Shock', unlockLevel:8, cost:20, cooldown:10, castTime:0, range:R15, kind:'ranged', damage:14, projectileSpeed:850, slow:{amount:0.6,duration:4}, needsTarget:'enemy', fxKind:'bolt', fxColor:'#7fdbff', desc:'Instant 14 dmg + 60% slow for 4s.' },
      { id:'elementalblast', name:'Elemental Blast', unlockLevel:10, cost:30, cooldown:8, castTime:1.5, range:R25, kind:'ranged', damage:38, projectileSpeed:700, needsTarget:'enemy', fxKind:'bolt', fxColor:'#66ccff', desc:'38 dmg of raw elements. 1.5s cast.' },
    ]},
};

const CLASS_ORDER = ['warrior','rogue','mage','priest','hunter','warlock','paladin','shaman'];

// ---- Ability pools & loadouts ----
// Each class has 4 base abilities plus 5 unlockable ones (levels 2/4/6/8/10).
// A player's LOADOUT is any 4 ability ids from the pool; entities carry their
// loadout and all ability lookups resolve through it.
function classPool(classId){
  const cd = CLASS_DATA[classId];
  return cd.abilities.concat(cd.unlocks||[]);
}
function defaultLoadoutIds(classId){
  return CLASS_DATA[classId].abilities.map(a=>a.id);
}
function validateLoadout(classId, ids){
  if (!Array.isArray(ids) || ids.length!==4) return null;
  const pool = classPool(classId);
  const out = [];
  for (const id of ids){
    if (out.includes(id)) return null;
    if (!pool.some(a=>a.id===id)) return null;
    out.push(id);
  }
  return out;
}
function entAbilities(ent){
  const pool = classPool(ent.classId);
  const ids = ent.loadout || defaultLoadoutIds(ent.classId);
  return ids.map(id=>pool.find(a=>a.id===id)).filter(Boolean);
}
function getAbilityFor(ent, id){
  return entAbilities(ent).find(a=>a.id===id) || null;
}
// ===== ARENA CONSTANTS =====
// +20% over the original 900x600: third person made the old arena feel like a
// box. Ranges now cover proportionally less field (kiting up, melee uptime down)
// — MOVE_SPEED is bumped alongside to soften traversal, re-simulated below.
const ARENA_W = 1080, ARENA_H = 720;
const ENTITY_R = 18;
const MOVE_SPEED = 168; // px/sec (+12% with the +20% arena: traversal stays close)
const GCD = 1.2; // 1.5 felt sluggish; 1.0 let instant-weaving burst outpace all healing (rogue hit 84% in sim)
let ACTIVE_WINS_NEEDED = 5;         // rounds to win the match — now room-configurable
function setMatchWins(n){ ACTIVE_WINS_NEEDED = clamp(Math.round(n)||5, 1, 15); }
const COUNTDOWN_MS = 3000;         // pre-round countdown
// Magic ability kinds that a silence prevents. Physical abilities (melee, gapcloser,
// cone, vanish, traps, self buffs) still work while silenced.
const SILENCE_BLOCKED_KINDS = ['ranged','heal','dotonly','channel','chainheal','fear','silence','hex','banish','interrupt','shield','selfshield','stunonly','nova','hot','aoeheal','targetaoe','freedom'];
// ---- MAPS ----
// Collision is circle-based (pillars); rectangles are approximated by circle rows
// hidden inside a covering structure. Elevation (heightAt) is RENDER-ONLY: the sim
// stays 2D, so maps can never desync gameplay between clients.
const MAPS = {
  nagrand: {
    name: 'Nagrand Pit', icon:'🌋',
    pillars: [
      { x: 360, y: 240, r: 42 }, { x: 720, y: 480, r: 42 },
      { x: 540, y: 198, r: 26 }, { x: 540, y: 522, r: 26 },
    ],
    boxes: [],
    fog: 0x120c14, ember: 0xffa040,
    sky: ['#05060d','#0d0e1e','#2a1220','#4a1e1c','#1a0c12'], // deep night -> volcanic ember horizon
  },
  bladesedge: {
    name: "Blade's Rift", icon:'⚔️',
    // two great pillars anchor the ends; a raised stone bridge spans between them
    // as a REAL collidable blocker (was cosmetic-only before). LoS play happens at
    // the bridge mouths, kiting around the pillar ends.
    pillars: [ { x: 540, y: 144, r: 41 }, { x: 540, y: 576, r: 41 } ],
    // the bridge deck blocks movement but is LOW — you can shoot over it, so it
    // doesn't block line of sight (blocksLoS:false). Pathing goes around the ends.
    boxes: [ { x: 540, y: 360, w: 96, d: 300, blocksLoS: false } ],
    bridge: { x0: 486, x1: 594, y0: 185, y1: 535, h: 1.5 },
    heightAt(x, y){
      const b = this.bridge;
      if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) return 0;
      const edge = Math.min(x - b.x0, b.x1 - x) / 31; // ramps on the long edges
      return b.h * Math.min(1, edge);
    },
    fog: 0x0c1218, ember: 0x66e0ff,
    sky: ['#040611','#0a1024','#0e2436','#1c4a55','#183038'], // deep space navy -> icy rift-teal horizon
  },
  ruins: {
    name: 'Ruins of the Fallen King', icon:'🪦',
    // the royal tomb: a single solid rectangular blocker (the classic Ruins of
    // Lordaeron dance around one big box). Now a TRUE rectangle collider — its
    // corners and flat faces match the rendered tomb exactly, instead of three
    // overlapping circles that left the corners walkable and LoS wrong.
    pillars: [],
    boxes: [ { x: 540, y: 360, w: 259, d: 120 } ],
    tomb: { x: 540, y: 360, w: 259, d: 120 },
    fog: 0x0c1410, ember: 0x7dff9a,
    sky: ['#04070a','#0a1210','#132018','#254a2a','#0e1a12'], // near-black -> sickly plague-green horizon
  },
};
let ACTIVE_MAP_ID = 'nagrand';
let PILLARS = MAPS.nagrand.pillars;
let BOXES = MAPS.nagrand.boxes;
function setActiveMap(id){
  if (!MAPS[id]) id = 'nagrand';
  ACTIVE_MAP_ID = id;
  PILLARS = MAPS[id].pillars;
  BOXES = MAPS[id].boxes || [];
}
function heightAtWorld(x, y){
  const m = MAPS[ACTIVE_MAP_ID];
  return m.heightAt ? m.heightAt(x, y) : 0;
}
const SPAWNS = {
  1: [ {x: 108, y: 180}, {x: 108, y: 360}, {x: 108, y: 540} ],
  2: [ {x: 972, y: 180}, {x: 972, y: 360}, {x: 972, y: 540} ],
};
const MAX_PLAYERS = 6;

function dist(a,b){ return Math.hypot(a.x-b.x, a.y-b.y); }
function clamp(v,lo,hi){ return Math.max(lo, Math.min(hi, v)); }

function segmentCircleBlocked(a, b, c, r){
  const dx = b.x-a.x, dy = b.y-a.y;
  const lenSq = dx*dx+dy*dy;
  let t = lenSq>0 ? ((c.x-a.x)*dx + (c.y-a.y)*dy)/lenSq : 0;
  t = clamp(t,0,1);
  const px = a.x+dx*t, py = a.y+dy*t;
  return dist({x:px,y:py}, c) < r;
}

// A box is { x, y, w, d } (center + full width/depth). Axis-aligned.
function pointInBox(px, py, box, pad){
  pad = pad || 0;
  return px > box.x - box.w/2 - pad && px < box.x + box.w/2 + pad &&
         py > box.y - box.d/2 - pad && py < box.y + box.d/2 + pad;
}

// Segment (a->b) vs axis-aligned box, using the slab method. Returns true if the
// segment enters the box at all. Used for LoS and projectile blocking so a solid
// rectangle blocks sightlines through its flat faces, not just near its center.
function segmentBoxBlocked(a, b, box){
  const minX = box.x - box.w/2, maxX = box.x + box.w/2;
  const minY = box.y - box.d/2, maxY = box.y + box.d/2;
  // quick accept: either endpoint inside
  if (pointInBox(a.x, a.y, box) || pointInBox(b.x, b.y, box)) return true;
  const dx = b.x - a.x, dy = b.y - a.y;
  let t0 = 0, t1 = 1;
  // X slab
  if (Math.abs(dx) < 1e-9) { if (a.x < minX || a.x > maxX) return false; }
  else {
    let tA = (minX - a.x)/dx, tB = (maxX - a.x)/dx;
    if (tA > tB) { const tmp=tA; tA=tB; tB=tmp; }
    t0 = Math.max(t0, tA); t1 = Math.min(t1, tB);
    if (t0 > t1) return false;
  }
  // Y slab
  if (Math.abs(dy) < 1e-9) { if (a.y < minY || a.y > maxY) return false; }
  else {
    let tA = (minY - a.y)/dy, tB = (maxY - a.y)/dy;
    if (tA > tB) { const tmp=tA; tA=tB; tB=tmp; }
    t0 = Math.max(t0, tA); t1 = Math.min(t1, tB);
    if (t0 > t1) return false;
  }
  return t1 >= 0 && t0 <= 1;
}

// Push a point out of a box along the shallowest axis (so a body pressed against
// a flat face slides along it rather than snapping to a corner).
function resolveBoxPush(nx, ny, box, pad){
  pad = pad || ENTITY_R;
  const minX = box.x - box.w/2 - pad, maxX = box.x + box.w/2 + pad;
  const minY = box.y - box.d/2 - pad, maxY = box.y + box.d/2 + pad;
  if (nx <= minX || nx >= maxX || ny <= minY || ny >= maxY) return { x:nx, y:ny };
  // inside the padded box: find the nearest face and push out along it
  const dLeft = nx - minX, dRight = maxX - nx, dTop = ny - minY, dBot = maxY - ny;
  const m = Math.min(dLeft, dRight, dTop, dBot);
  if (m === dLeft) nx = minX;
  else if (m === dRight) nx = maxX;
  else if (m === dTop) ny = minY;
  else ny = maxY;
  return { x:nx, y:ny };
}

function hasLineOfSight(a, b){
  for (const p of PILLARS) {
    if (segmentCircleBlocked(a, b, p, p.r)) return false;
  }
  for (const box of BOXES) {
    if (box.blocksLoS === false) continue; // low deck — shootable over
    if (segmentBoxBlocked(a, b, box)) return false;
  }
  return true;
}

// Push a point out of any pillar it overlaps. Used by movement, dashes, and teleports
// so no ability can ever leave an entity stuck inside a pillar.
function resolvePillarPush(nx, ny){
  PILLARS.forEach(p=>{
    const dd = dist({x:nx,y:ny}, p);
    if (dd < p.r+ENTITY_R) {
      const ux=(nx-p.x)/(dd||1), uy=(ny-p.y)/(dd||1);
      nx = p.x + ux*(p.r+ENTITY_R); ny = p.y + uy*(p.r+ENTITY_R);
    }
  });
  BOXES.forEach(box=>{
    const r = resolveBoxPush(nx, ny, box);
    nx = r.x; ny = r.y;
  });
  return {x:nx, y:ny};
}

function freshEntity(player, spawnPos){
  const cd = CLASS_DATA[player.classId];
  const loadout = validateLoadout(player.classId, player.loadout) || defaultLoadoutIds(player.classId);
  const cooldowns = {};
  const pool = classPool(player.classId);
  loadout.forEach(id => { if (pool.some(a=>a.id===id)) cooldowns[id] = 0; });
  return {
    id: player.id, name: player.name, team: player.team, classId: player.classId,
    x: spawnPos.x, y: spawnPos.y, facing: player.team===1?0:Math.PI,
    hp: cd.maxHp, maxHp: cd.maxHp, bonusMaxHp: 0,
    resource: cd.resource==='energy' ? cd.maxResource : (cd.resource==='rage'?0:cd.maxResource),
    maxResource: cd.maxResource,
    dead: false, moveDir: {x:0,y:0}, dash: null,
    cooldowns, gcdUntil: 0,
    casting: null, // {abilityId, targetId, startTime, endTime}
    channel: null,
    stunUntil: 0, rootUntil: 0, silenceUntil: 0, fearUntil: 0,
    slowUntil: 0, slowAmount: 0,
    invulnUntil: 0, untargetableUntil: 0,
    dmgReduction: 0, dmgReductionUntil: 0,
    shield: 0, shieldUntil: 0,
    dots: [], // {damagePerTick, ticksLeft, tickInterval, nextTick, source}
    lastProcessedSeq: 0,
    lastCombatTime: Date.now()-999999, regenBurstUntil: 0, xCooldownUntil: 0, lastProcessedRecoverSeq: 0,
    nextAutoAttackAt: 0, teleportSeq: 0, lastAutoAttackAt: 0, hexedUntil: 0, banishedUntil: 0,
    loadout,
    cosmetics: player.cosmetics && typeof player.cosmetics==='object'
      ? { outfit: String(player.cosmetics.outfit||'default'), helmet: String(player.cosmetics.helmet||'none') }
      : { outfit:'default', helmet:'none' },
    hots: [],                       // heal-over-time effects
    jumpStartAt: 0, lastJumpSeq: 0, // jumping (visual hop, synced to everyone)
    speedBuffUntil: 0, speedMult: 1,
    freedomUntil: 0,                // immune to roots & slows
    ccImmuneUntil: 0,               // immune to all CC (Bladestorm)
    autoHasteUntil: 0,              // auto-attacks twice as fast (Rapid Fire)
    dmgBuffUntil: 0, dmgBuffMult: 1,
  };
}

function initialState(players){
  const entities = {};
  const mapId = ACTIVE_MAP_ID;
  const winsNeeded = ACTIVE_WINS_NEEDED;
  const counts = {1:0,2:0};
  Object.values(players).forEach(p=>{
    if (!p || !p.id || p.removed) return; // skip metadata (_rev) and removed players
    const idx = counts[p.team]++;
    entities[p.id] = freshEntity(p, SPAWNS[p.team][idx] || SPAWNS[p.team][0]);
  });
  return {
    mapId,
    winsNeeded,
    phase: 'countdown',
    round: 1,
    score: {1:0, 2:0},
    countdownEnd: Date.now() + COUNTDOWN_MS,
    intermissionEnd: 0,
    entities,
    fx: [],
    spellFx: [],
    projectiles: [],
    log: [],
    hostId: null,
    lastTick: Date.now(),
    winner: null,
  };
}

function resetRound(state, players){
  const counts = {1:0,2:0};
  Object.values(players).forEach(p=>{
    if (!p || !p.id || p.removed) return; // skip metadata (_rev) and removed players
    const idx = counts[p.team]++;
    const prev = state.entities[p.id];
    const fresh = freshEntity(p, SPAWNS[p.team][idx] || SPAWNS[p.team][0]);
    // carry input sequence counters across the reset: clients keep counting up, so a
    // fresh 0 here would make the previous round's final cast replay at round start
    if (prev) {
      fresh.lastProcessedSeq = prev.lastProcessedSeq;
      fresh.lastProcessedRecoverSeq = prev.lastProcessedRecoverSeq;
    }
    state.entities[p.id] = fresh;
  });
  state.fx = [];
  state.spellFx = [];
  state.traps = [];
  state.projectiles = [];
}

function pushFx(state, x, y, text, color){
  state.fx.push({ x, y, text, color, t: Date.now() });
  if (state.fx.length > 24) state.fx.shift();
}

function pushSpellFx(state, kind, color, from, to, casterId){
  if (!state.spellFx) state.spellFx = [];
  state._fxIdCounter = (state._fxIdCounter||0) + 1;
  state.spellFx.push({ id: state._fxIdCounter, kind, color, fromX: from.x, fromY: from.y, toX: to.x, toY: to.y, t: Date.now(), casterId });
  if (state.spellFx.length > 30) state.spellFx.shift();
}

// ---- Global pacing scale ----
// Multiplies ALL damage and ALL healing equally. Because the damage:healing
// ratio is preserved, no class gets relatively stronger or weaker — this purely
// stretches time-to-kill so fights last longer. 0.66 lifts the ~25s average
// fight to ~37-40s (+12-15s), landing both 2v2 and 3v3 inside the requested
// +10-20s window. Tuned against simulations.
const PACING_SCALE = 0.66;

function applyDamage(state, target, amount, source){
  if (!target || target.dead) return 0;
  // attacking from Vanish reveals you — 2s of untouchable free damage was broken
  if (source && Date.now() < (source.untargetableUntil||0)) source.untargetableUntil = 0;
  if (Date.now() < target.invulnUntil) { pushFx(state, target.x, target.y-30, 'IMMUNE', '#ffd700'); return 0; }
  target.lastCombatTime = Date.now();
  if (source) source.lastCombatTime = Date.now();
  let dmg = amount * PACING_SCALE;
  if (source && Date.now() < (source.dmgBuffUntil||0)) dmg *= (source.dmgBuffMult||1);
  if (Date.now() < target.dmgReductionUntil) dmg *= (1 - target.dmgReduction);
  if (target.shield > 0 && Date.now() < target.shieldUntil) {
    const absorbed = Math.min(target.shield, dmg);
    target.shield -= absorbed;
    dmg -= absorbed;
  }
  dmg = Math.round(dmg);
  // Clamp against maxHp + bonusMaxHp so temporary HP buffs (Rallying Cry) aren't wiped by the first hit
  target.hp = clamp(target.hp - dmg, 0, target.maxHp + target.bonusMaxHp);
  if (dmg > 0) pushFx(state, target.x, target.y-30, '-'+dmg, '#ff5555');
  // warrior rage on taking damage
  if (target.classId==='warrior' && dmg>0) {
    target.resource = clamp(target.resource + Math.floor(dmg*0.3), 0, target.maxResource);
  }
  if (target.hp <= 0 && !target.dead) {
    target.dead = true;
    target.casting = null; target.channel = null;
    pushFx(state, target.x, target.y-50, 'DEFEATED', '#ff0000');
  }
  return dmg;
}

function applyHeal(state, target, amount){
  if (!target || target.dead) return;
  amount *= PACING_SCALE; // same scale as damage — preserves the damage:healing ratio
  const before = target.hp;
  target.hp = clamp(target.hp + amount, 0, target.maxHp + target.bonusMaxHp);
  const healed = target.hp - before;
  if (healed > 0) pushFx(state, target.x, target.y-30, '+'+healed, '#55ff55');
}

function nearestEnemy(state, ent){
  let best=null, bd=Infinity;
  Object.values(state.entities).forEach(o=>{
    if (o.team!==ent.team && !o.dead && !isUntargetable(o)) { const d=dist(ent,o); if(d<bd){bd=d;best=o;} }
  });
  return best;
}

function nearestEnemyInRange(state, ent, range){
  let best=null, bd=Infinity;
  Object.values(state.entities).forEach(o=>{
    if (o.team!==ent.team && !o.dead && !isUntargetable(o)) {
      const d=dist(ent,o);
      if (d<=range && d<bd && hasLineOfSight(ent,o)) { bd=d; best=o; }
    }
  });
  return best;
}

function enemiesInCone(state, ent, range, angleDeg){
  const out=[];
  const facing = ent.facing;
  Object.values(state.entities).forEach(o=>{
    if (o.team===ent.team || o.dead) return;
    const d = dist(ent,o);
    if (d>range) return;
    const ang = Math.atan2(o.y-ent.y, o.x-ent.x);
    let diff = Math.abs(ang-facing);
    if (diff>Math.PI) diff = 2*Math.PI-diff;
    if (diff <= (angleDeg*Math.PI/180)/2 && hasLineOfSight(ent,o)) out.push(o);
  });
  return out;
}

function alliesOf(state, ent){
  return Object.values(state.entities).filter(o=>o.team===ent.team && o.id!==ent.id && !o.dead);
}

// CC immunity gates: Bladestorm blocks everything; Freedom blocks roots & slows.
function ccImmune(e){ return Date.now() < (e.ccImmuneUntil||0); }
function rootSlowImmune(e){ return ccImmune(e) || Date.now() < (e.freedomUntil||0); }
function applyStunTo(state, t, sec){ if (ccImmune(t)) { pushFx(state,t.x,t.y-30,'IMMUNE','#ffd700'); return; } t.stunUntil = Math.max(t.stunUntil, Date.now()+sec*1000); }
function applyRootTo(state, t, sec){ if (rootSlowImmune(t)) { pushFx(state,t.x,t.y-30,'IMMUNE','#ffd700'); return; } t.rootUntil = Math.max(t.rootUntil, Date.now()+sec*1000); }
function applySlowTo(state, t, amount, sec){ if (rootSlowImmune(t)) return; t.slowUntil = Date.now()+sec*1000; t.slowAmount = amount; }
function applyFearTo(state, t, sec){ if (ccImmune(t)) { pushFx(state,t.x,t.y-30,'IMMUNE','#ffd700'); return; } t.fearUntil = Math.max(t.fearUntil, Date.now()+sec*1000); }
function applySilenceTo(state, t, sec){ if (ccImmune(t)) { pushFx(state,t.x,t.y-30,'IMMUNE','#ffd700'); return; } t.silenceUntil = Math.max(t.silenceUntil, Date.now()+sec*1000); }

function isStunned(e){ return Date.now() < e.stunUntil; }
function isRooted(e){ return Date.now() < e.rootUntil && !rootSlowImmune(e); }
function isSilenced(e){ return Date.now() < e.silenceUntil; }
function isFeared(e){ return Date.now() < e.fearUntil; }
function isUntargetable(e){ return Date.now() < e.untargetableUntil; }

// Process one ability cast attempt. Returns nothing; mutates state.
function tryCast(state, caster, abilityId, targetId){
  if (!caster || caster.dead) return;
  if (isStunned(caster) || isFeared(caster)) return;
  if (caster.casting || caster.channel) return;
  if (Date.now() < caster.gcdUntil) return;
  const cd = CLASS_DATA[caster.classId];
  const ability = getAbilityFor(caster, abilityId); // resolves through the caster's loadout
  if (!ability) return;
  if (isSilenced(caster) && ability.castTime>0) return; // silenced blocks cast-time spells
  if (isSilenced(caster) && SILENCE_BLOCKED_KINDS.includes(ability.kind)) return;
  if ((caster.cooldowns[ability.id]||0) > Date.now()) return;
  if (caster.resource < ability.cost) return;
  if (ability.kind==='gapcloser' && isRooted(caster)) return; // can't dash while rooted
  if (caster.dash) return; // can't act mid-Charge

  let target = targetId ? state.entities[targetId] : null;
  if (target && target.dead) target = null;
  if (target && isUntargetable(target) && ability.needsTarget==='enemy') target = null;

  // resolve default targets
  if (ability.needsTarget==='ally' || ability.needsTarget==='allyorself') {
    if (!target || target.team!==caster.team) target = caster;
  }
  if (ability.needsTarget==='enemy' && target && target.team===caster.team) target = null;
  if (ability.needsTarget==='enemy' && !target) {
    // Auto-target: nearest living, targetable enemy within the ability's range (with LoS)
    target = nearestEnemyInRange(state, caster, ability.range>0 ? ability.range : 99999);
    if (!target) return;
  }

  // range check
  if (ability.range > 0 && target) {
    if (dist(caster,target) > ability.range) return;
    if (!hasLineOfSight(caster, target)) { pushFx(state, caster.x, caster.y-30, 'NO LINE OF SIGHT', '#ff8844'); return; }
  }

  // pay cost & start gcd
  caster.resource -= ability.cost;
  caster.gcdUntil = Date.now() + GCD*1000;
  caster.cooldowns[ability.id] = Date.now() + ability.cooldown*1000;
  caster.lastCombatTime = Date.now();
  if (ability.rageGain) caster.resource = clamp(caster.resource + ability.rageGain, 0, caster.maxResource);

  // face target
  if (target) caster.facing = Math.atan2(target.y-caster.y, target.x-caster.x);
  else { const ne = nearestEnemy(state, caster); if (ne) caster.facing = Math.atan2(ne.y-caster.y, ne.x-caster.x); }

  if (ability.castTime > 0) {
    caster.casting = { abilityId: ability.id, targetId: target?target.id:null, startTime: Date.now(), endTime: Date.now()+ability.castTime*1000 };
    return;
  }
  if (ability.kind==='channel') {
    caster.channel = { abilityId: ability.id, targetId: target?target.id:null, startTime: Date.now(), endTime: Date.now()+ability.channelDuration*1000, lastTick: Date.now() };
    return;
  }
  resolveAbilityEffect(state, caster, ability, target);
}

// Shared on-hit payload for melee/ranged abilities (direct hits and projectile impacts).
function applyRangedHit(state, caster, ability, target){
  if (!target || target.dead) return;
  if (isUntargetable(target)) { pushFx(state, target.x, target.y-30, 'MISS', '#aaaacc'); return; }
  let dmg = ability.damage;
  if (ability.executeThreshold && target.hp <= target.maxHp*ability.executeThreshold) dmg = ability.executeDamage;
  applyDamage(state, target, dmg, caster);
  if (ability.dot) addDot(target, ability.dot, caster);
  if (ability.slow) applySlowTo(state, target, ability.slow.amount, ability.slow.duration);
  if (ability.stun) applyStunTo(state, target, ability.stun);
  if (ability.selfHeal && caster) applyHeal(state, caster, ability.selfHeal);
}

// Spawn a homing projectile in the shared sim state; damage lands on impact (tickProjectiles).
function spawnProjectile(state, caster, ability, target){
  if (!state.projectiles) state.projectiles = [];
  state._projIdCounter = (state._projIdCounter||0) + 1;
  state.projectiles.push({
    id: state._projIdCounter, x: caster.x, y: caster.y,
    sourceId: caster.id, targetId: target.id,
    abilityId: ability.id, classId: caster.classId,
    color: ability.fxColor||'#ffffff', speed: ability.projectileSpeed,
    born: Date.now(),
  });
}

function resolveAbilityEffect(state, caster, ability, target){
  const fxTarget = target || caster;
  // Render-only telemetry: which ability just resolved, and its kind, so the
  // client can play an appropriate arm animation (sword swing, spell-cast
  // gesture, etc.) even for INSTANT abilities that have no cast-time windup to
  // key off (auto-attacks already had their own timestamp; this covers
  // everything else — Slam, Charge's impact, Holy Strike, and so on).
  caster.lastAbilityKind = ability.kind;
  caster.lastAbilityAt = Date.now();
  // Projectile spells draw their own traveling visual — skip the instant line fx for those.
  const usesProjectile = ability.kind==='ranged' && ability.projectileSpeed && target;
  if (!usesProjectile) pushSpellFx(state, ability.fxKind||'utility', ability.fxColor||'#ffffff', {x:caster.x,y:caster.y}, {x:fxTarget.x,y:fxTarget.y}, caster.id);
  switch(ability.kind){
    case 'gapcloser': {
      // Charge is a dash, not a teleport: movement happens over time in tickEntity,
      // and damage + stun land on arrival. Cancels if target dies/vanishes.
      if (target) {
        caster.dash = { targetId: target.id, speed: ability.dashSpeed||900, damage: ability.damage, stun: ability.stun||0, started: Date.now() };
        pushFx(state, caster.x, caster.y-30, 'CHARGE!', ability.fxColor||'#ffaa55');
      }
      break;
    }
    case 'melee':
    case 'ranged': {
      if (target) {
        if (usesProjectile) { spawnProjectile(state, caster, ability, target); break; }
        applyRangedHit(state, caster, ability, target);
      }
      break;
    }
    case 'dotonly': {
      if (target) addDot(target, ability.dot, caster);
      break;
    }
    case 'stunonly': {
      if (target) applyStunTo(state, target, ability.stun);
      break;
    }
    case 'interrupt': {
      // Counterplay tool: cancels an in-progress cast/channel and locks the school out.
      // Deliberately wasted if the target wasn't casting — timing it is the skill.
      if (target) {
        if (target.casting || target.channel) {
          target.casting = null; target.channel = null;
          target.silenceUntil = Date.now() + ability.lockout*1000;
          pushFx(state, target.x, target.y-30, 'INTERRUPTED!', '#4db8ff');
        } else {
          pushFx(state, caster.x, caster.y-30, 'NO CAST TO INTERRUPT', '#8899aa');
        }
      }
      break;
    }
    case 'silence': {
      if (target) applySilenceTo(state, target, ability.duration);
      break;
    }
    case 'hex': {
      // Silence + heavy slow: answers both casters (silence) and melee (slow)
      if (target) {
        applySilenceTo(state, target, ability.duration);
        applySlowTo(state, target, ability.slowAmount, ability.duration);
        target.hexedUntil = Date.now() + ability.duration*1000; // render-only: drives the cat transform, distinct from generic silence
      }
      break;
    }
    case 'banish': {
      if (target) {
        applySilenceTo(state, target, ability.duration); applyRootTo(state, target, ability.duration);
        target.banishedUntil = Date.now() + ability.duration*1000; // render-only: drives the prison visual
      }
      break;
    }
    case 'fear': {
      if (target) applyFearTo(state, target, ability.duration);
      break;
    }
    case 'heal': {
      applyHeal(state, target, ability.amount);
      break;
    }
    case 'chainheal': {
      applyHeal(state, target, ability.amount);
      // Jump to the most injured living ally (of the target) in range, excluding the target itself.
      const candidates = Object.values(state.entities).filter(o=>
        o.team===target.team && o.id!==target.id && !o.dead && dist(target,o)<=ability.secondaryRange);
      candidates.sort((a,b)=>(a.hp/(a.maxHp+a.bonusMaxHp)) - (b.hp/(b.maxHp+b.bonusMaxHp)));
      if (candidates[0]) applyHeal(state, candidates[0], ability.secondaryAmount);
      break;
    }
    case 'shield': {
      target.shield = ability.shield; target.shieldUntil = Date.now()+ability.duration*1000;
      pushFx(state, target.x, target.y-30, 'SHIELD', '#7fdbff');
      break;
    }
    case 'selfshield': {
      caster.shield = ability.shield; caster.shieldUntil = Date.now()+ability.duration*1000;
      pushFx(state, caster.x, caster.y-30, 'SHIELD', '#7fdbff');
      break;
    }
    case 'selfbuff': {
      caster.dmgReduction = ability.damageReduction; caster.dmgReductionUntil = Date.now()+ability.duration*1000;
      pushFx(state, caster.x, caster.y-30, 'BLOCK', '#ffd700');
      break;
    }
    case 'teambuff': {
      [caster, ...alliesOf(state, caster)].forEach(e=>{
        if (!e) return;
        const bonus = Math.round(CLASS_DATA[e.classId].maxHp*ability.hpBuffPct);
        e.bonusMaxHp = bonus; e.maxHp = CLASS_DATA[e.classId].maxHp;
        e.hp = clamp(e.hp+bonus, 0, e.maxHp+e.bonusMaxHp);
        e._buffExpire = Date.now()+ability.duration*1000;
        pushFx(state, e.x, e.y-30, 'RALLY', '#ffaa00');
      });
      break;
    }
    case 'vanish': {
      caster.untargetableUntil = Date.now()+ability.duration*1000;
      caster.stunUntil = 0; caster.rootUntil = 0; caster.fearUntil=0; caster.silenceUntil=0;
      pushFx(state, caster.x, caster.y-30, 'VANISH', '#ffff88');
      break;
    }
    case 'blink': case 'disengage': {
      let dx=0, dy=0;
      const enemy = nearestEnemy(state, caster);
      if (ability.kind==='blink') {
        // Blink follows movement INTENT: if you're steering, you blink that way;
        // standing still, you blink along facing. (Facing alone pointed at whoever
        // you last cast on — blinking INTO the enemy chasing you felt broken.)
        if (caster.moveDir && (caster.moveDir.x || caster.moveDir.y)) {
          const ml = Math.hypot(caster.moveDir.x, caster.moveDir.y) || 1;
          dx = caster.moveDir.x/ml; dy = caster.moveDir.y/ml;
        } else {
          dx = Math.cos(caster.facing); dy = Math.sin(caster.facing);
        }
      } else if (enemy) {
        const d = Math.max(1, dist(caster, enemy));
        dx = (caster.x-enemy.x)/d; dy = (caster.y-enemy.y)/d;
      } else { dx=-1; dy=0; }
      const bx = clamp(caster.x + dx*ability.distance, ENTITY_R, ARENA_W-ENTITY_R);
      const by = clamp(caster.y + dy*ability.distance, ENTITY_R, ARENA_H-ENTITY_R);
      const safe = resolvePillarPush(bx, by); // never teleport inside a pillar
      caster.x = safe.x; caster.y = safe.y;
      // teleports must be announced: client prediction matches server positions
      // against the player's own recent path, so an unannounced jump BACK along
      // that path reads as "no divergence" and never renders (the "Blink and
      // Disengage don't work" bug). Bumping this counter forces a client snap.
      caster.teleportSeq = (caster.teleportSeq||0) + 1;
      break;
    }
    case 'shockwave': {
      // point-blank AoE around the caster (Thunder Clap): damage + optional slow
      Object.values(state.entities).forEach(o=>{
        if (o.team!==caster.team && !o.dead && !isUntargetable(o) && dist(caster,o)<=ability.radius) {
          if (ability.damage) applyDamage(state, o, ability.damage, caster);
          if (ability.slow) applySlowTo(state, o, ability.slow.amount, ability.slow.duration);
        }
      });
      break;
    }
    case 'targetaoe': {
      // AoE centered on the TARGET (Meteor, Shadowfury)
      if (target) {
        pushSpellFx(state, 'aoe', ability.fxColor||'#ffffff', {x:target.x,y:target.y}, {x:target.x,y:target.y});
        Object.values(state.entities).forEach(o=>{
          if (o.team!==caster.team && !o.dead && !isUntargetable(o) && dist(target,o)<=ability.radius) {
            if (ability.damage) applyDamage(state, o, ability.damage, caster);
            if (ability.stun) applyStunTo(state, o, ability.stun);
          }
        });
      }
      break;
    }
    case 'hot': {
      // heal over time (Renew, Riptide) — optional upfront amount
      if (ability.amount) applyHeal(state, target, ability.amount);
      if (ability.hotTotal) {
        const ticks = Math.round(ability.hotDuration/1.5);
        target.hots.push({ perTick: ability.hotTotal/ticks, ticksLeft: ticks, nextTick: Date.now()+1500 });
      }
      break;
    }
    case 'aoeheal': {
      applyHeal(state, caster, ability.amount);
      alliesOf(state, caster).forEach(a=>applyHeal(state, a, ability.amount));
      break;
    }
    case 'speedbuff': {
      caster.speedBuffUntil = Date.now()+ability.duration*1000;
      caster.speedMult = ability.mult;
      pushFx(state, caster.x, caster.y-30, 'SPRINT', '#5ee0ff');
      break;
    }
    case 'freedom': {
      target.freedomUntil = Date.now()+ability.duration*1000;
      target.rootUntil = 0; target.slowUntil = 0;
      pushFx(state, target.x, target.y-30, 'FREEDOM', '#ffe9a8');
      break;
    }
    case 'ccimmune': {
      caster.ccImmuneUntil = Date.now()+ability.duration*1000;
      caster.stunUntil=0; caster.rootUntil=0; caster.fearUntil=0; caster.silenceUntil=0; caster.slowUntil=0;
      pushFx(state, caster.x, caster.y-30, 'UNSTOPPABLE', '#ff8a2e');
      break;
    }
    case 'shadowstep': {
      // teleport behind the target into melee range
      if (target) {
        const d = Math.max(1, dist(caster,target));
        const ux=(target.x-caster.x)/d, uy=(target.y-caster.y)/d;
        const safe = resolvePillarPush(
          clamp(target.x + ux*(MELEE*0.6), ENTITY_R, ARENA_W-ENTITY_R),
          clamp(target.y + uy*(MELEE*0.6), ENTITY_R, ARENA_H-ENTITY_R));
        caster.x = safe.x; caster.y = safe.y;
        caster.facing = Math.atan2(target.y-caster.y, target.x-caster.x);
        caster.teleportSeq = (caster.teleportSeq||0) + 1;
      }
      break;
    }
    case 'autohaste': {
      caster.autoHasteUntil = Date.now()+ability.duration*1000;
      pushFx(state, caster.x, caster.y-30, 'RAPID FIRE', '#abd473');
      break;
    }
    case 'dmgbuff': {
      caster.dmgBuffUntil = Date.now()+ability.duration*1000;
      caster.dmgBuffMult = ability.mult;
      pushFx(state, caster.x, caster.y-30, 'WRATH', '#ffd700');
      break;
    }
    case 'nova': {
      // Frost Nova: instant point-blank freeze around the caster.
      Object.values(state.entities).forEach(o=>{
        if (o.team!==caster.team && !o.dead && !isUntargetable(o) && dist(caster,o)<=ability.radius) {
          if (ability.damage) applyDamage(state, o, ability.damage, caster);
          if (ability.rootDuration) { applyRootTo(state, o, ability.rootDuration); pushFx(state, o.x, o.y-30, 'FROZEN', '#7fdbff'); }
          if (ability.slow) applySlowTo(state, o, ability.slow.amount, ability.slow.duration);
          pushSpellFx(state, 'freeze', ability.fxColor||'#7fdbff', {x:o.x,y:o.y}, {x:o.x,y:o.y});
        }
      });
      break;
    }
    case 'immune': {
      caster.invulnUntil = Date.now()+ability.duration*1000;
      pushFx(state, caster.x, caster.y-30, 'DIVINE', '#ffffff');
      break;
    }
    case 'trap': {
      if (!state.traps) state.traps=[];
      state._trapId = (state._trapId||0) + 1;
      state.traps.push({ id: state._trapId, x: caster.x, y: caster.y, team: caster.team, expiresAt: Date.now()+ability.duration*1000, rootDuration: ability.rootDuration });
      break;
    }
    case 'cone': {
      const coneEnd = { x: caster.x+Math.cos(caster.facing)*ability.range*0.6, y: caster.y+Math.sin(caster.facing)*ability.range*0.6 };
      pushSpellFx(state, 'aoe', ability.fxColor||'#ffffff', {x:caster.x,y:caster.y}, coneEnd, caster.id);
      const targets = enemiesInCone(state, caster, ability.range, ability.coneAngle);
      targets.forEach(t=>applyDamage(state, t, ability.damage, caster));
      break;
    }
  }
}

function addDot(target, dotDef, source){
  const ticks = Math.round(dotDef.duration/1.5);
  target.dots.push({ perTick: dotDef.total/ticks, ticksLeft: ticks, nextTick: Date.now()+1500, source });
}

function tryRecover(state, ent){
  if (!ent || ent.dead) return;
  if (isStunned(ent) || isFeared(ent)) return;
  const now = Date.now();
  if (now - ent.lastCombatTime < 5000) return; // must be out of combat 5s
  if (now < ent.xCooldownUntil) return;
  ent.xCooldownUntil = now + 30000;
  ent.regenBurstUntil = now + 4000;
  ent.resource = clamp(ent.resource + 15, 0, ent.maxResource);
  pushFx(state, ent.x, ent.y-30, 'RECOVERING', '#5ee0ff');
}

function tickEntity(state, ent, dt){
  if (ent.dead) return;
  const now = Date.now();
  const cd = CLASS_DATA[ent.classId];

  // resource regen
  const inBurst = now < ent.regenBurstUntil;
  if (cd.resource==='mana') ent.resource = clamp(ent.resource + (inBurst?40:5)*dt, 0, ent.maxResource);
  if (cd.resource==='energy') ent.resource = clamp(ent.resource + (inBurst?60:10)*dt, 0, ent.maxResource);
  if (cd.resource==='rage' && inBurst) ent.resource = clamp(ent.resource + 15*dt, 0, ent.maxResource);

  // buff expiry
  if (ent._buffExpire && now > ent._buffExpire) {
    ent.bonusMaxHp = 0; ent.maxHp = cd.maxHp; ent.hp = Math.min(ent.hp, ent.maxHp);
    ent._buffExpire = null;
  }

  // heal-over-time effects
  ent.hots = (ent.hots||[]).filter(h=>h.ticksLeft>0);
  ent.hots.forEach(h=>{
    if (now >= h.nextTick) { applyHeal(state, ent, h.perTick); h.ticksLeft--; h.nextTick = now+1500; }
  });

  // dots
  ent.dots = ent.dots.filter(d=>d.ticksLeft>0);
  ent.dots.forEach(d=>{
    if (now >= d.nextTick) {
      applyDamage(state, ent, d.perTick, d.source);
      d.ticksLeft--; d.nextTick = now+1500;
    }
  });

  // moving cancels an in-progress cast/channel
  const isMoving = !!(ent.moveDir && (ent.moveDir.x || ent.moveDir.y));
  if (isMoving && (ent.casting || ent.channel) && !isStunned(ent) && !isRooted(ent)) {
    ent.casting = null; ent.channel = null;
    pushFx(state, ent.x, ent.y-30, 'INTERRUPTED', '#ff8844');
  }

  // auto-attack: automatic damage when an enemy is in range (melee for warrior/rogue,
  // ranged auto-shot for hunter). Requires line of sight — LoS is the counterplay.
  if (cd.autoAttack && !isStunned(ent) && !isFeared(ent)) {
    if (now >= ent.nextAutoAttackAt) {
      const tgt = nearestEnemyInRange(state, ent, cd.autoAttack.range || MELEE);
      if (tgt) {
        applyDamage(state, tgt, cd.autoAttack.damage, ent);
        pushSpellFx(state, cd.autoAttack.fxKind||'melee', cd.autoAttack.fxColor||cd.color, {x:ent.x,y:ent.y}, {x:tgt.x,y:tgt.y}, ent.id);
        ent.lastAutoAttackAt = now; // render-only: drives the swing/recoil animation
        if (cd.autoAttack.rageGain) ent.resource = clamp(ent.resource + cd.autoAttack.rageGain, 0, ent.maxResource);
        ent.facing = Math.atan2(tgt.y-ent.y, tgt.x-ent.x);
        const haste = now < (ent.autoHasteUntil||0) ? 0.5 : 1;
        ent.nextAutoAttackAt = now + cd.autoAttack.interval*1000*haste;
      }
    }
  }

  // cast completion
  if (ent.casting && now >= ent.casting.endTime) {
    const ability = getAbilityFor(ent, ent.casting.abilityId);
    let target = ent.casting.targetId ? state.entities[ent.casting.targetId] : null;
    // target vanished/became untargetable during the cast -> the spell fizzles
    if (target && isUntargetable(target) && ability && ability.needsTarget==='enemy') {
      pushFx(state, ent.x, ent.y-30, 'TARGET LOST', '#aaaacc');
      target = null;
      if (ability.needsTarget==='enemy') { ent.casting = null; }
    }
    if (target && ability && ability.needsTarget==='enemy' && ability.range>0 && !hasLineOfSight(ent, target)) {
      pushFx(state, ent.x, ent.y-30, 'NO LINE OF SIGHT', '#ff8844');
      ent.casting = null; target = null;
    }
    if (ability && (target || ability.needsTarget!=='enemy')) resolveAbilityEffect(state, ent, ability, target);
    ent.casting = null;
  }
  // interrupt cast on stun/fear
  if (ent.casting && (isStunned(ent) || isFeared(ent))) ent.casting = null;

  // channel
  if (ent.channel) {
    const ability = getAbilityFor(ent, ent.channel.abilityId);
    const target = ent.channel.targetId ? state.entities[ent.channel.targetId] : null;
    if (isStunned(ent) || isFeared(ent)) { ent.channel = null; }
    else if (now >= ent.channel.endTime) { ent.channel = null; }
    else if (now - ent.channel.lastTick >= 1000) {
      if (target && !target.dead) applyDamage(state, target, ability.damagePerSec, ent);
      applyHeal(state, ent, ability.healPerSec);
      if (target) pushSpellFx(state, ability.fxKind||'dot', ability.fxColor||'#9482C9', {x:ent.x,y:ent.y}, {x:target.x,y:target.y}, ent.id);
      ent.channel.lastTick = now;
    }
  }

  // Charge dash: homing movement toward the target, damage + stun on arrival.
  // Cancels if the target dies/vanishes, the warrior is stunned/feared, or it times out.
  let dashing = false;
  if (ent.dash) {
    const tgt = state.entities[ent.dash.targetId];
    const expired = now - ent.dash.started > 1500;
    if (!tgt || tgt.dead || isUntargetable(tgt) || isStunned(ent) || isFeared(ent) || expired) {
      ent.dash = null;
    } else {
      const d = dist(ent, tgt);
      if (d <= MELEE) {
        // impact
        applyRangedHit(state, ent, { damage: ent.dash.damage, stun: ent.dash.stun }, tgt);
        pushSpellFx(state, 'melee', '#ffaa55', {x:tgt.x,y:tgt.y}, {x:tgt.x,y:tgt.y});
        ent.facing = Math.atan2(tgt.y-ent.y, tgt.x-ent.x);
        ent.dash = null;
      } else {
        dashing = true;
        const step = Math.min(d - MELEE*0.6, ent.dash.speed*dt);
        const ux=(tgt.x-ent.x)/d, uy=(tgt.y-ent.y)/d;
        let nx = clamp(ent.x+ux*step, ENTITY_R, ARENA_W-ENTITY_R);
        let ny = clamp(ent.y+uy*step, ENTITY_R, ARENA_H-ENTITY_R);
        const safe = resolvePillarPush(nx, ny);
        ent.x = safe.x; ent.y = safe.y;
        ent.facing = Math.atan2(uy, ux);
      }
    }
  }

  // fear: random wander (dash takes priority over fear movement; both still hit traps below)
  if (isFeared(ent) && !dashing) {
    if (!ent._fearDir || Math.random()<0.05) ent._fearDir = Math.random()*Math.PI*2;
    const beforeX = ent.x, beforeY = ent.y;
    moveEntity(ent, ent.x+Math.cos(ent._fearDir)*100, ent.y+Math.sin(ent._fearDir)*100, dt, true);
    // blocked by a wall or pillar? bounce to a fresh direction instead of grinding
    // into the obstacle (looked like phasing through geometry with interpolation)
    const movedSq = (ent.x-beforeX)*(ent.x-beforeX) + (ent.y-beforeY)*(ent.y-beforeY);
    const expected = MOVE_SPEED*dt*0.35;
    if (movedSq < expected*expected) ent._fearDir = Math.random()*Math.PI*2;
  }

  // movement (WASD direction-based)
  if (!dashing && !isFeared(ent) && !isStunned(ent) && !isRooted(ent)) {
    moveEntityDir(ent, dt);
  }

  // trap check — runs for everyone, including feared/dashing entities
  if (state.traps) {
    state.traps = state.traps.filter(t=>t.expiresAt>now);
    state.traps.forEach(t=>{
      if (t.team!==ent.team && dist(ent,t)<48) { // was 30 — needed near-exact overlap, felt unreliable
        applyRootTo(state, ent, t.rootDuration);
        ent.dash = null; // trap stops a Charge in its tracks
        t.expiresAt = 0;
        pushFx(state, ent.x, ent.y-30, 'TRAPPED', '#ff8800');
      }
    });
  }
}

function effectiveSpeed(ent){
  const now = Date.now();
  let sp = MOVE_SPEED;
  if (now < ent.slowUntil && !rootSlowImmune(ent)) sp *= (1-ent.slowAmount);
  if (now < (ent.speedBuffUntil||0)) sp *= (ent.speedMult||1);
  return sp;
}

function moveEntity(ent, tx, ty, dt, ignoreArrive){
  const speed = effectiveSpeed(ent);
  const d = dist(ent, {x:tx,y:ty});
  if (d < 4 && !ignoreArrive) { return; }
  const step = Math.min(d, speed*dt);
  const ux = (tx-ent.x)/(d||1), uy=(ty-ent.y)/(d||1);
  let nx = ent.x + ux*step, ny = ent.y + uy*step;
  nx = clamp(nx, ENTITY_R, ARENA_W-ENTITY_R);
  ny = clamp(ny, ENTITY_R, ARENA_H-ENTITY_R);
  const safe = resolvePillarPush(nx, ny);
  ent.x = safe.x; ent.y = safe.y;
  if (d>1) ent.facing = Math.atan2(uy,ux);
}

function moveEntityDir(ent, dt){
  const dir = ent.moveDir || {x:0,y:0};
  if (!dir.x && !dir.y) return;
  const speed = effectiveSpeed(ent);
  let nx = ent.x + dir.x*speed*dt;
  let ny = ent.y + dir.y*speed*dt;
  nx = clamp(nx, ENTITY_R, ARENA_W-ENTITY_R);
  ny = clamp(ny, ENTITY_R, ARENA_H-ENTITY_R);
  const safe = resolvePillarPush(nx, ny);
  ent.x = safe.x; ent.y = safe.y;
  ent.facing = Math.atan2(dir.y, dir.x);
}

// Advance all in-flight projectiles. Homing: they track the target's live position,
// deal their ability's full on-hit payload on impact, and fizzle if the target
// dies or becomes untargetable (Vanish) mid-flight.
function tickProjectiles(state, dt){
  if (!state.projectiles || !state.projectiles.length) return;
  const now = Date.now();
  state.projectiles = state.projectiles.filter(pr=>{
    const src = state.entities[pr.sourceId];
    const tgt = state.entities[pr.targetId];
    if (!tgt || tgt.dead || isUntargetable(tgt)) return false; // fizzle
    if (now - pr.born > 6000) return false; // safety valve
    const d = dist(pr, tgt);
    const step = pr.speed*dt;
    // pillars block projectiles: check the segment this tick travels
    {
      const nx = pr.x + (tgt.x-pr.x)/(d||1)*step, ny = pr.y + (tgt.y-pr.y)/(d||1)*step;
      let blocked = false;
      for (const p of PILLARS){
        if (segmentCircleBlocked({x:pr.x,y:pr.y}, {x:nx,y:ny}, p, p.r)) { blocked = true; break; }
      }
      if (!blocked) for (const box of BOXES){
        if (box.blocksLoS === false) continue; // low deck — projectiles pass over
        if (segmentBoxBlocked({x:pr.x,y:pr.y}, {x:nx,y:ny}, box)) { blocked = true; break; }
      }
      if (blocked) {
        pushSpellFx(state, 'melee', '#8890aa', {x:pr.x,y:pr.y}, {x:pr.x,y:pr.y});
        pushFx(state, pr.x, pr.y-16, 'BLOCKED', '#8890aa');
        return false; // projectile fizzles on the obstacle
      }
    }
    if (d <= Math.max(step, 26)) {
      const cd = CLASS_DATA[pr.classId];
      const ability = cd ? classPool(pr.classId).find(a=>a.id===pr.abilityId) : null;
      if (ability && src) applyRangedHit(state, src, ability, tgt);
      pushSpellFx(state, 'melee', pr.color, {x:tgt.x,y:tgt.y}, {x:tgt.x,y:tgt.y}); // impact ring
      return false;
    }
    pr.x += (tgt.x-pr.x)/d*step;
    pr.y += (tgt.y-pr.y)/d*step;
    return true;
  });
}

function checkRoundEnd(state, players){
  const teamAlive = {1:0,2:0};
  Object.values(state.entities).forEach(e=>{ if (!e.dead) teamAlive[e.team]++; });
  if (teamAlive[1]===0 || teamAlive[2]===0) {
    const winningTeam = teamAlive[1]===0 ? 2 : 1;
    state.score[winningTeam]++;
    if (state.score[winningTeam] >= (state.winsNeeded||5)) {
      state.phase = 'gameover'; state.winner = winningTeam;
    } else {
      state.phase = 'intermission'; state.intermissionEnd = Date.now()+3000; state.round++;
    }
    return true;
  }
  return false;
}

function simTick(state, players, inputsByPlayer, dt){
  state.lastTick = Date.now();
  if (state.phase==='countdown') {
    if (Date.now() >= state.countdownEnd) state.phase='fight';
    return;
  }
  if (state.phase==='intermission') {
    if (Date.now() >= state.intermissionEnd) {
      resetRound(state, players);
      state.phase='countdown';
      state.countdownEnd = Date.now()+COUNTDOWN_MS;
    }
    return;
  }
  if (state.phase!=='fight') return;

  // apply inputs
  Object.keys(inputsByPlayer).forEach(pid=>{
    const ent = state.entities[pid];
    const input = inputsByPlayer[pid];
    if (!ent || !input || ent.dead) return;
    if (input.moveDir) ent.moveDir = input.moveDir;
    if (input.cast && input.cast.seq > ent.lastProcessedSeq) {
      ent.lastProcessedSeq = input.cast.seq;
      tryCast(state, ent, input.cast.abilityId, input.cast.targetId);
    }
    if (input.jump && input.jump.seq > (ent.lastJumpSeq||0)) {
      ent.lastJumpSeq = input.jump.seq;
      // jumping: 600ms parabolic hop, full air control, no gameplay effect.
      // Not while stunned/feared/rooted (feet must be free), fine while slowed.
      if (!ent.dead && !isStunned(ent) && !isFeared(ent) && !isRooted(ent)
          && Date.now() > (ent.jumpStartAt||0) + 650) {
        ent.jumpStartAt = Date.now();
      }
    }
    if (input.recover && input.recover.seq > ent.lastProcessedRecoverSeq) {
      ent.lastProcessedRecoverSeq = input.recover.seq;
      tryRecover(state, ent);
    }
  });

  Object.values(state.entities).forEach(ent=>tickEntity(state, ent, dt));
  tickProjectiles(state, dt);
  checkRoundEnd(state, players);
}

/* ======== EMBEDDED BOT AI (generated from game.html) ======== */
const BotAI = (function(){
  const mems = {}; // pid -> {seq, recSeq}
  const RANGE_PREF = { warrior:0, rogue:0, paladin:0, mage:385, priest:385, hunter:470, warlock:430, shaman:430 };

  function hpPct(e){ return e.hp / (e.maxHp + e.bonusMaxHp); }
  function abil(ent, id){ return getAbilityFor(ent, id); }
  function canUse(ent, a){
    return a && (ent.cooldowns[a.id]||0) <= Date.now() && ent.resource >= a.cost
      && Date.now() >= ent.gcdUntil && !ent.casting && !ent.channel && !ent.dash;
  }
  function mostInjuredAlly(state, me){
    const allies = Object.values(state.entities).filter(o=>o.team===me.team && !o.dead);
    allies.sort((a,b)=>hpPct(a)-hpPct(b));
    return allies[0];
  }

  function decide(state, pid){
    const me = state.entities[pid];
    const mem = mems[pid] || (mems[pid] = { seq: 100000 + Math.floor(Math.random()*1000) });
    if (!me || me.dead) return { moveDir:{x:0,y:0} };
    let enemy = nearestEnemy(state, me);
    // kill focus: swap to the most wounded visible enemy when someone is low —
    // real players focus kills, and team fights feel wrong without it
    {
      let lowest = null;
      Object.values(state.entities).forEach(o=>{
        if (o.team===me.team || o.dead || isUntargetable(o)) return;
        if (!lowest || hpPct(o) < hpPct(lowest)) lowest = o;
      });
      if (lowest && enemy && hpPct(lowest) < 0.4 && dist(me,lowest) < 620 && hasLineOfSight(me,lowest)) enemy = lowest;
    }
    const input = { moveDir:{x:0,y:0} };
    const busy = me.casting || me.channel || me.dash;

    let castId = null, castTarget = enemy ? enemy.id : null;
    const c = me.classId;
    const inj = mostInjuredAlly(state, me);

    if (!busy && enemy) {
      const d = dist(me, enemy);
      const los = hasLineOfSight(me, enemy);
      const inR = (id)=>{ const a=abil(me,id); return a && d<=a.range && (a.range===0||los); };
      const enemyCCd = isStunned(enemy) || Date.now()<enemy.rootUntil || Date.now()<enemy.fearUntil;
      const enemySpeed = Date.now()<enemy.slowUntil ? MOVE_SPEED*(1-enemy.slowAmount) : MOVE_SPEED;
      const safeCast = (castTime)=> enemyCCd || d > castTime*enemySpeed + 140;
      const canHeal = (id)=>{ const a=abil(me,id); return canUse(me,a) && (safeCast(a.castTime) || hpPct(me)<0.35); };
      const enemyIsMelee = RANGE_PREF[enemy.classId]===0;

      if (c==='warrior'){
        if (canUse(me,abil(me,'charge')) && d>MELEE+20 && d<=abil(me,'charge').range && los) castId='charge';
        else if (canUse(me,abil(me,'shieldblock')) && hpPct(me)<0.5) castId='shieldblock';
        else if (canUse(me,abil(me,'rallyingcry')) && hpPct(me)<0.7 && me.resource>=40) castId='rallyingcry';
        else if (canUse(me,abil(me,'slam')) && d<=MELEE) castId='slam';
      } else if (c==='rogue'){
        if (canUse(me,abil(me,'vanish')) && (hpPct(me)<0.3 || Date.now()<me.rootUntil || Date.now()<me.silenceUntil || Date.now()<me.fearUntil)) castId='vanish';
        else if (canUse(me,abil(me,'cheapshot')) && d<=MELEE && !isStunned(enemy)) castId='cheapshot';
        else if (canUse(me,abil(me,'shadowstep')) && d>MELEE*1.6 && d<=500 && hasLineOfSight(me,enemy)) castId='shadowstep';
        else if (canUse(me,abil(me,'backstab')) && d<=MELEE) castId='backstab';
      } else if (c==='mage'){
        if (canUse(me,abil(me,'counterspell')) && (enemy.casting||enemy.channel) && inR('counterspell')) castId='counterspell';
        else if (canUse(me,abil(me,'frostnova')) && d<=140) castId='frostnova';      // freeze them on top of you...
        else if (canUse(me,abil(me,'blink')) && d<120) castId='blink';               // ...then blink out
        else if (canUse(me,abil(me,'frostbolt')) && inR('frostbolt') && safeCast(1.2)) castId='frostbolt';
      } else if (c==='priest'){
        if (canHeal('heal') && inj && hpPct(inj)<0.6) { castId='heal'; castTarget=inj.id; }
        else if (canUse(me,abil(me,'powershield')) && me.shield<=0 && hpPct(me)<0.8) { castId='powershield'; castTarget=me.id; }
        else if (canUse(me,abil(me,'fear')) && d<=250 && los) castId='fear';
        else if (canUse(me,abil(me,'smite')) && inR('smite') && safeCast(1.2)) castId='smite';
      } else if (c==='hunter'){
        if (canUse(me,abil(me,'frosttrap')) && d<220) castId='frosttrap';
        else if (canUse(me,abil(me,'disengage')) && d<130) castId='disengage';
        else if (canUse(me,abil(me,'multishot')) && d<=450 && los && d>120) castId='multishot';
        else if (canUse(me,abil(me,'aimedshot')) && inR('aimedshot') && safeCast(1.5)) castId='aimedshot';
      } else if (c==='warlock'){
        if (canUse(me,abil(me,'banish')) && los && !isSilenced(enemy) && ((enemyIsMelee && d<=380) || d<=250)) castId='banish';
        else if (canUse(me,abil(me,'corruption')) && enemy.dots.length===0 && inR('corruption')) castId='corruption';
        else if (canUse(me,abil(me,'drainlife')) && hpPct(me)<0.6 && inR('drainlife')) castId='drainlife';
        else if (canUse(me,abil(me,'shadowbolt')) && inR('shadowbolt') && safeCast(1.2)) castId='shadowbolt';
      } else if (c==='paladin'){
        if (canUse(me,abil(me,'divineshield')) && hpPct(me)<0.25) castId='divineshield';
        else if (canHeal('holylight') && inj && hpPct(inj)<0.55) { castId='holylight'; castTarget=inj.id; }
        else if (canUse(me,abil(me,'hammerofjustice')) && d<=200 && los && !isStunned(enemy)) castId='hammerofjustice';
        else if (canUse(me,abil(me,'holystrike')) && d<=MELEE) castId='holystrike';
      } else if (c==='shaman'){
        if (canUse(me,abil(me,'hex')) && d<=400 && los && (enemy.casting || (enemyIsMelee && d<320) || d<160)) castId='hex';
        else if (canHeal('chainheal') && inj && hpPct(inj)<0.6) { castId='chainheal'; castTarget=inj.id; }
        else if (canUse(me,abil(me,'earthshield')) && me.shield<=0 && hpPct(me)<0.85) { castId='earthshield'; castTarget=me.id; }
        else if (canUse(me,abil(me,'lightningbolt')) && inR('lightningbolt') && safeCast(1.2)) castId='lightningbolt';
      }

      // ~12% hesitation so bots don't play with inhuman precision
      if (castId && Math.random() < 0.12) castId = null;

      if (castId) {
        mem.seq++;
        input.cast = { abilityId: castId, targetId: castTarget, seq: mem.seq };
        input.moveDir = {x:0,y:0}; // stand still to start the cast
        return input;
      }

      if (busy) return input;

      // movement: seek preferred range, kite if crowded, strafe a little
      const want = RANGE_PREF[c];
      let dx=0, dy=0;
      const ux=(enemy.x-me.x)/(d||1), uy=(enemy.y-me.y)/(d||1);
      const jitter = (Math.random()-0.5)*0.6;
      const px = -uy*jitter, py = ux*jitter;
      if (want===0) {
        if (d > MELEE*0.8) { dx=ux+px; dy=uy+py; }
      } else {
        if (!los) {
          // LoS blocked: strafe PERPENDICULAR around the pillar (toward arena
          // center to avoid walls) with a small forward component. Walking
          // straight at the pillar just grinds into it — with four pillars that
          // permanently disabled ranged bots.
          const cx = ARENA_W/2 - me.x, cy = ARENA_H/2 - me.y;
          const side = (-uy*cx + ux*cy) >= 0 ? 1 : -1;
          const fwd = d > want ? 0.8 : 0.3; // far away: keep closing while circling
          dx = -uy*side + ux*fwd; dy = ux*side + uy*fwd;
        }
        else if (d > want) { dx=ux+px; dy=uy+py; }
        else if (d < want-120) { dx=-ux+px; dy=-uy+py; }
      }
      const len = Math.hypot(dx,dy);
      if (len>0){ dx/=len; dy/=len; }
      input.moveDir = {x:dx, y:dy};
    }
    return input;
  }

  return { decide };
})();

/* ---------------- Minimal RFC 6455 WebSocket ---------------- */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key){
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

// Encode a server->client text frame (unmasked)
function encodeFrame(str){
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.from([0x81, len]); }
  else if (len < 65536) { header = Buffer.alloc(4); header[0]=0x81; header[1]=126; header.writeUInt16BE(len,2); }
  else { header = Buffer.alloc(10); header[0]=0x81; header[1]=127; header.writeBigUInt64BE(BigInt(len),2); }
  return Buffer.concat([header, payload]);
}
function encodePong(payload){
  return Buffer.concat([Buffer.from([0x8A, payload.length]), payload]);
}
function encodeClose(){ return Buffer.from([0x88, 0]); }

// Streaming frame parser: feeds complete text messages to onText
function makeFrameParser(sock, onText, onClose){
  let buf = Buffer.alloc(0);
  return function feed(chunk){
    buf = Buffer.concat([buf, chunk]);
    for(;;){
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX_MSG) { onClose('oversize'); return; }
      const maskOff = off, dataOff = off + (masked ? 4 : 0);
      if (buf.length < dataOff + len) return; // wait for more
      let data = buf.slice(dataOff, dataOff + len);
      if (masked) {
        const mask = buf.slice(maskOff, maskOff + 4);
        data = Buffer.from(data); // copy before mutating
        for (let i=0;i<data.length;i++) data[i] ^= mask[i & 3];
      }
      buf = buf.slice(dataOff + len);
      if (opcode === 1 && fin) onText(data.toString('utf8'));
      else if (opcode === 9) { try { sock.write(encodePong(data)); } catch(e){} } // ping->pong
      else if (opcode === 8) { onClose('close-frame'); return; }
      // opcode 0 (continuation) / 2 (binary): not used by this client — ignored
    }
  };
}

/* ---------------- Rooms & lobby (server-authoritative) ---------------- */
const rooms = new Map(); // code -> room

// ---- Global leaderboard (across all rooms), persisted to disk ----
const fs = require('fs');
const LB_FILE = process.env.LB_FILE || './leaderboard.json';
let leaderboard = {}; // name -> { wins, games }
try { leaderboard = JSON.parse(fs.readFileSync(LB_FILE, 'utf8')) || {}; } catch(e){ leaderboard = {}; }
let lbSaveTimer = null;
function saveLeaderboard(){
  if (lbSaveTimer) return; // debounce bursts of match-ends into one write
  lbSaveTimer = setTimeout(()=>{
    lbSaveTimer = null;
    try { fs.writeFileSync(LB_FILE, JSON.stringify(leaderboard)); } catch(e){}
  }, 1000);
}
function recordLeaderboardResult(name, won){
  name = String(name||'Player').slice(0,24);
  const e = leaderboard[name] || { wins:0, games:0 };
  e.games++; if (won) e.wins++;
  leaderboard[name] = e;
  saveLeaderboard();
}
function sortedLeaderboard(){
  return Object.entries(leaderboard)
    .map(([name,e])=>({ name, wins:e.wins||0, games:e.games||0, rate: e.games?(e.wins/e.games):0 }))
    .sort((a,b)=> b.wins-a.wins || b.rate-a.rate || a.name.localeCompare(b.name))
    .slice(0, 25);
}
function broadcastLeaderboard(r){
  broadcast(r, { t:'leaderboard', d: sortedLeaderboard() });
}


function getRoom(code){
  let r = rooms.get(code);
  if (!r) {
    r = { code, players: {}, state: null, phase: 'lobby',
          inputs: {}, sockets: new Map(), // pid -> conn
          simTimer: null, castTimer: null, lastActivity: Date.now(),
          lobbyValidSince: 0 };
    rooms.set(code, r);
  }
  return r;
}

function roomPlayersArr(r){ return Object.values(r.players).filter(p=>!p.removed); }

function broadcast(r, msg){
  const frame = encodeFrame(JSON.stringify(msg));
  for (const conn of r.sockets.values()) {
    if (conn.alive) { try { conn.sock.write(frame); } catch(e){} }
  }
}
function sendTo(conn, msg){
  try { conn.sock.write(encodeFrame(JSON.stringify(msg))); } catch(e){}
}
function broadcastPlayers(r){
  broadcast(r, { t:'players', d: r.players, phase: r.phase, mapId: r.mapId||'nagrand', wins: r.wins||5 });
}

function lobbyValid(r){
  const arr = roomPlayersArr(r);
  const c = {1:0,2:0};
  arr.forEach(p=>c[p.team]++);
  return arr.length>=2 && c[1]===c[2] && c[1]<=3 && arr.every(p=>p.ready);
}

function startMatch(r){
  setActiveMap(r.mapId||'nagrand'); // this room's arena drives collision + spawns
  setMatchWins(r.wins||5); // this room's chosen match length
  r.state = initialState(r.players);
  r.state.hostId = 'server';
  r.phase = 'fight'; // server phase label; state.phase drives countdown/fight
  r.inputs = {};
  r.simLast = Date.now();
  if (r.simTimer) clearInterval(r.simTimer);
  if (r.castTimer) clearInterval(r.castTimer);
  r.simTimer = setInterval(()=>{
    const now = Date.now();
    const dt = Math.min((now - r.simLast)/1000, 1.0);
    r.simLast = now;
    const st = r.state;
    if (!st) return;
    // rooms on different maps share the sim's global PILLARS — pin per tick
    setActiveMap(st.mapId||'nagrand');
    if (st.phase !== 'gameover') {
      if (st.phase === 'fight') {
        roomPlayersArr(r).forEach(p=>{
          if (p.isBot && st.entities[p.id]) r.inputs[p.id] = BotAI.decide(st, p.id);
        });
      }
      simTick(st, r.players, r.inputs, dt);
    }
  }, TICK_MS);
  r.castTimer = setInterval(()=>{
    if (r.state) broadcast(r, { t:'st', d: r.state });
  }, BROADCAST_MS);
  broadcast(r, { t:'start', d: r.state });
  log(r.code, 'match started with', roomPlayersArr(r).map(p=>p.name).join(', '));
}

function resetToLobby(r){
  if (r.simTimer) { clearInterval(r.simTimer); r.simTimer = null; }
  if (r.castTimer) { clearInterval(r.castTimer); r.castTimer = null; }
  r.state = null;
  r.phase = 'lobby';
  r.lobbyValidSince = 0;
  roomPlayersArr(r).forEach(p=>{ if (!p.isBot) p.ready = false; p.requestReset = false; });
  broadcast(r, { t:'lobby' });
  broadcastPlayers(r);
}

// lobby heartbeat: start matches (1s grace after everyone readies), clean rooms
setInterval(()=>{
  const now = Date.now();
  for (const [code, r] of rooms) {
    r.lastActivity = r.sockets.size ? now : r.lastActivity;
    if (!r.sockets.size && now - r.lastActivity > ROOM_IDLE_TTL) {
      if (r.simTimer) clearInterval(r.simTimer);
      if (r.castTimer) clearInterval(r.castTimer);
      rooms.delete(code);
      log(code, 'room expired');
      continue;
    }
    if (r.phase === 'lobby') {
      if (lobbyValid(r)) {
        if (!r.lobbyValidSince) r.lobbyValidSince = now;
        else if (now - r.lobbyValidSince > 1000) startMatch(r);
      } else r.lobbyValidSince = 0;
    } else if (r.state && r.state.phase === 'gameover') {
      if (roomPlayersArr(r).some(p=>p.requestReset)) resetToLobby(r);
    }
  }
}, 300);

function log(...a){ console.log(new Date().toISOString(), ...a); }

/* ---------------- Message handling ---------------- */
const BOT_NAMES = ['Gary','Randy','Terry','Phil','Dale','Keith'];

function handleMessage(conn, msg){
  const r = conn.room ? rooms.get(conn.room) : null;
  switch (msg.t) {
    case 'hello': { // {t, room, pid, name}
      const code = String(msg.room||'').toUpperCase().slice(0,8);
      const pid = String(msg.pid||'').slice(0,24);
      if (!code || !pid) return;
      const room = getRoom(code);
      conn.room = code; conn.pid = pid;
      const existing = room.sockets.get(pid);
      if (existing && existing !== conn) { existing.alive = false; try{ existing.sock.destroy(); }catch(e){} }
      room.sockets.set(pid, conn);
      if (!room.players[pid] || room.players[pid].removed) {
        const arr = roomPlayersArr(room);
        const c = {1:0,2:0}; arr.forEach(p=>c[p.team]++);
        room.players[pid] = { id: pid, name: String(msg.name||'Player').slice(0,16),
          team: c[1]<=c[2]?1:2, classId: 'warrior', ready: false, removed: false,
          lastSeen: Date.now(), joinOrder: arr.length, v: 1 };
      }
      room.players[pid].lastSeen = Date.now();
      sendTo(conn, { t:'welcome', room: code, phase: room.phase });
      sendTo(conn, { t:'leaderboard', d: sortedLeaderboard() });
      broadcastPlayers(room);
      // rejoining an in-progress match: resume the stream immediately
      if (room.state && room.state.phase !== 'gameover' && room.state.entities[pid]) {
        sendTo(conn, { t:'start', d: room.state });
      }
      break;
    }
    case 'update': { // {t, patch}
      if (!r || !conn.pid || !r.players[conn.pid]) return;
      const p = r.players[conn.pid];
      const patch = msg.patch || {};
      ['name','team','classId','ready','loadout','cosmetics','requestReset'].forEach(k=>{
        if (k in patch) p[k] = patch[k];
      });
      p.lastSeen = Date.now();
      broadcastPlayers(r);
      break;
    }
    case 'addBot': {
      if (!r || r.phase!=='lobby') return;
      const arr = roomPlayersArr(r);
      if (arr.length >= 6) return;
      // Prefer the client's id/name (its optimistic local insert already used
      // them) so this broadcast reconciles that same record instead of
      // spawning a second, duplicate bot entry.
      const idOk = typeof msg.id==='string' && /^bot_[a-z0-9]{1,12}$/.test(msg.id) && !r.players[msg.id];
      const id = idOk ? msg.id : ('bot_' + Math.random().toString(36).slice(2,8));
      const used = arr.filter(p=>p.isBot).map(p=>p.name);
      const name = (typeof msg.name==='string' && msg.name.trim())
        ? msg.name.trim().slice(0,16)
        : (BOT_NAMES.find(n=>!used.includes(n)) || ('Bot'+Math.floor(Math.random()*99)));
      r.players[id] = { id, name, team: msg.team===2?2:1, classId:'warrior', ready:true,
        isBot:true, removed:false, lastSeen: Date.now(), joinOrder: arr.length, v:1 };
      broadcastPlayers(r);
      break;
    }
    case 'removeBot': {
      if (!r || !r.players[msg.id] || !r.players[msg.id].isBot) return;
      delete r.players[msg.id];
      broadcastPlayers(r);
      break;
    }
    case 'setBotClass': {
      if (!r) return;
      const b = r.players[msg.id];
      if (b && b.isBot && CLASS_DATA[msg.classId]) { b.classId = msg.classId; broadcastPlayers(r); }
      break;
    }
    case 'setMap': {
      if (r && r.phase==='lobby' && MAPS[msg.mapId]) { r.mapId = msg.mapId; broadcastPlayers(r); }
      break;
    }
    case 'setWins': {
      if (r && r.phase==='lobby' && Number.isFinite(msg.wins)) {
        r.wins = Math.max(1, Math.min(15, Math.round(msg.wins)));
        broadcastPlayers(r);
      }
      break;
    }
    case 'matchResult': {
      // A client reporting its own match outcome. Recorded by NAME into the
      // global board. (Trust model matches the rest of this friendly-play
      // server — the client already reports its own inputs authoritatively.)
      recordLeaderboardResult(msg.name, !!msg.won);
      if (r) broadcastLeaderboard(r);
      break;
    }
    case 'getLeaderboard': {
      if (conn) sendTo(conn, { t:'leaderboard', d: sortedLeaderboard() });
      break;
    }
    case 'in': { // gameplay input
      if (r && conn.pid && r.state) r.inputs[conn.pid] = msg.d;
      break;
    }
    case 'ping': sendTo(conn, { t:'pong', ts: msg.ts }); break;
    case 'leave': {
      if (r && conn.pid && r.players[conn.pid]) {
        r.players[conn.pid].removed = true;
        r.sockets.delete(conn.pid);
        broadcastPlayers(r);
      }
      break;
    }
  }
}

/* ---------------- HTTP + upgrade ---------------- */
const server = http.createServer((req, res)=>{
  res.writeHead(200, {'Content-Type':'text/plain'});
  res.end('Dad Discord Duels server — connect via WebSocket. Rooms active: ' + rooms.size + '\n');
});

server.on('upgrade', (req, sock)=>{
  const key = req.headers['sec-websocket-key'];
  if (!key) { sock.destroy(); return; }
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + 'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n');
  sock.setNoDelay(true);
  const conn = { sock, alive: true, room: null, pid: null, msgTimes: [] };
  const feed = makeFrameParser(sock, (text)=>{
    // rate cap: 120 msgs / sec
    const now = Date.now();
    conn.msgTimes.push(now);
    while (conn.msgTimes.length && conn.msgTimes[0] < now-1000) conn.msgTimes.shift();
    if (conn.msgTimes.length > 120) return;
    let msg; try { msg = JSON.parse(text); } catch(e){ return; }
    try { handleMessage(conn, msg); } catch(e){ log('handler error', e.message); }
  }, ()=>{ try{ sock.write(encodeClose()); }catch(e){} sock.end(); });
  sock.on('data', feed);
  const drop = ()=>{
    conn.alive = false;
    if (conn.room && conn.pid) {
      const r = rooms.get(conn.room);
      if (r && r.sockets.get(conn.pid)===conn) {
        r.sockets.delete(conn.pid);
        // grace: keep the player entry; a reconnect resumes seamlessly.
        setTimeout(()=>{
          const r2 = rooms.get(conn.room);
          if (r2 && !r2.sockets.has(conn.pid) && r2.players[conn.pid] && !r2.players[conn.pid].isBot) {
            if (r2.phase==='lobby') { r2.players[conn.pid].removed = true; broadcastPlayers(r2); }
          }
        }, DISCONNECT_GRACE);
      }
    }
  };
  sock.on('close', drop);
  sock.on('error', drop);
});

server.listen(PORT, ()=>log('Dad Discord Duels server listening on :' + PORT));

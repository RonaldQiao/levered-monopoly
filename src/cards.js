'use strict';
// Card decks. "Market Event" ~ chance, "Town Treasury" ~ community chest.
// A few cards are macro shocks that hit the central-bank economy model.

const EVENT_CARDS = [
  { text: 'Advance to PAYDAY. Collect your salary.', type: 'advance', to: 0 },
  { text: 'Advance to Crown Point.', type: 'advance', to: 39 },
  { text: 'Advance to Opera Plaza. If you pass PAYDAY, collect salary.', type: 'advance', to: 24 },
  { text: 'Advance to Rose Court. If you pass PAYDAY, collect salary.', type: 'advance', to: 14 },
  { text: 'Advance to the nearest transit hub. If owned, pay the owner twice the rent.', type: 'nearest', kind: 'transit' },
  { text: 'Advance to the nearest transit hub. If owned, pay the owner twice the rent.', type: 'nearest', kind: 'transit' },
  { text: 'Advance to the nearest utility. If owned, roll and pay 10x the dice.', type: 'nearest', kind: 'utility' },
  { text: 'Your index fund pays a dividend. Collect $50.', type: 'collect', amount: 50 },
  { text: 'Get out of Lockup free. Keep this card until needed.', type: 'jailCard' },
  { text: 'Go back 3 spaces.', type: 'back', n: 3 },
  { text: 'Insider trading probe! Go directly to Lockup.', type: 'jail' },
  { text: 'Building inspection: pay $25 per house and $100 per hotel.', type: 'repairs', house: 25, hotel: 100 },
  { text: 'Parking ticket. Pay $15.', type: 'pay', amount: 15 },
  { text: 'Take a trip to North Station. If you pass PAYDAY, collect salary.', type: 'advance', to: 5 },
  { text: 'You were elected board chair. Pay each player $50.', type: 'payEach', amount: 50 },
  { text: 'Your construction bond matures. Collect $150.', type: 'collect', amount: 150 },
  { text: 'HAWKISH SURPRISE: the central bank hikes the policy rate by 1.00%.', type: 'macro', rate: 1.0 },
  { text: 'EMERGENCY CUT: the central bank slashes the policy rate by 1.00%.', type: 'macro', rate: -1.0 },
  { text: 'OIL SHOCK: inflation jumps. Price level +4%.', type: 'macro', price: 0.04 },
  { text: 'TECH BOOM: the economy heats up (+15 heat this round).', type: 'macro', heat: 15 },
];

const TREASURY_CARDS = [
  { text: 'Advance to PAYDAY. Collect your salary.', type: 'advance', to: 0 },
  { text: 'Bank error in your favour. Collect $200.', type: 'collect', amount: 200 },
  { text: 'Dentist bill. Pay $50.', type: 'pay', amount: 50 },
  { text: 'You sold some shares. Collect $50.', type: 'collect', amount: 50 },
  { text: 'Get out of Lockup free. Keep this card until needed.', type: 'jailCard' },
  { text: 'Tax audit gone wrong. Go directly to Lockup.', type: 'jail' },
  { text: 'Holiday savings mature. Collect $100.', type: 'collect', amount: 100 },
  { text: 'Tax refund. Collect $20.', type: 'collect', amount: 20 },
  { text: 'It is your birthday. Collect $10 from every player.', type: 'collectEach', amount: 10 },
  { text: 'Insurance payout. Collect $100.', type: 'collect', amount: 100 },
  { text: 'Hospital fees. Pay $100.', type: 'pay', amount: 100 },
  { text: 'Tuition fees. Pay $50.', type: 'pay', amount: 50 },
  { text: 'Consulting fee. Collect $25.', type: 'collect', amount: 25 },
  { text: 'Street works levy: pay $40 per house and $115 per hotel.', type: 'repairs', house: 40, hotel: 115 },
  { text: 'Second prize in a design contest. Collect $10.', type: 'collect', amount: 10 },
  { text: 'You inherit $100.', type: 'collect', amount: 100 },
  { text: 'FISCAL STIMULUS: the treasury mails every player $50.', type: 'macroAll', amount: 50, heat: 5 },
  { text: 'AUSTERITY: spending cuts cool the economy (-15 heat this round).', type: 'macro', heat: -15 },
];

module.exports = { EVENT_CARDS, TREASURY_CARDS };

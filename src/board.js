'use strict';
// Board for "Margin Call". The economics follow the traditional property-trading
// rules (prices, rent tables, 40 spaces); names and branding are original.

const GROUPS = {
  brown:  { name: 'Mill District',   color: '#9b6b43', houseCost: 50 },
  sky:    { name: 'Harbourside',     color: '#5ec8f2', houseCost: 50 },
  pink:   { name: 'Garden Quarter',  color: '#e85aa7', houseCost: 100 },
  orange: { name: 'Market Ward',     color: '#f59a3a', houseCost: 100 },
  red:    { name: 'Theatre Row',     color: '#e8463c', houseCost: 150 },
  yellow: { name: 'Gold Coast',      color: '#f2d43a', houseCost: 150 },
  green:  { name: 'Parkland',        color: '#3fbf6a', houseCost: 200 },
  navy:   { name: 'Crown Heights',   color: '#4f63e6', houseCost: 200 },
};

const S = (name, group, price, rent) => ({ type: 'street', name, group, price, rent });
const T = (name) => ({ type: 'transit', name, price: 200 });
const U = (name) => ({ type: 'utility', name, price: 150 });

const SPACES = [
  { type: 'go', name: 'PAYDAY' },
  S('Mill Street', 'brown', 60, [2, 10, 30, 90, 160, 250]),
  { type: 'treasury', name: 'Town Treasury' },
  S('Tannery Row', 'brown', 60, [4, 20, 60, 180, 320, 450]),
  { type: 'tax', name: 'Income Tax', amount: 200 },
  T('North Station'),
  S('Harbour Walk', 'sky', 100, [6, 30, 90, 270, 400, 550]),
  { type: 'event', name: 'Market Event' },
  S('Canal Street', 'sky', 100, [6, 30, 90, 270, 400, 550]),
  S('Lighthouse Road', 'sky', 120, [8, 40, 100, 300, 450, 600]),
  { type: 'jail', name: 'Lockup' },
  S('Orchard Lane', 'pink', 140, [10, 50, 150, 450, 625, 750]),
  U('Grid Power Co.'),
  S('Garden Terrace', 'pink', 140, [10, 50, 150, 450, 625, 750]),
  S('Rose Court', 'pink', 160, [12, 60, 180, 500, 700, 900]),
  T('East Ferry Terminal'),
  S('Bazaar Street', 'orange', 180, [14, 70, 200, 550, 750, 950]),
  { type: 'treasury', name: 'Town Treasury' },
  S('Spice Alley', 'orange', 180, [14, 70, 200, 550, 750, 950]),
  S('Market Square', 'orange', 200, [16, 80, 220, 600, 800, 1000]),
  { type: 'parking', name: 'Coffee Break' },
  S('Gallery Avenue', 'red', 220, [18, 90, 250, 700, 875, 1050]),
  { type: 'event', name: 'Market Event' },
  S('Playhouse Lane', 'red', 220, [18, 90, 250, 700, 875, 1050]),
  S('Opera Plaza', 'red', 240, [20, 100, 300, 750, 925, 1100]),
  T('South Tramway'),
  S('Amber Way', 'yellow', 260, [22, 110, 330, 800, 975, 1150]),
  S('Saffron Heights', 'yellow', 260, [22, 110, 330, 800, 975, 1150]),
  U('City Aqueduct'),
  S('Goldleaf Avenue', 'yellow', 280, [24, 120, 360, 850, 1025, 1200]),
  { type: 'gotojail', name: 'Go to Lockup' },
  S('Ivy Park', 'green', 300, [26, 130, 390, 900, 1100, 1275]),
  S('Fern Gardens', 'green', 300, [26, 130, 390, 900, 1100, 1275]),
  { type: 'treasury', name: 'Town Treasury' },
  S('Emerald Drive', 'green', 320, [28, 150, 450, 1000, 1200, 1400]),
  T('West Airport'),
  { type: 'event', name: 'Market Event' },
  S('Sapphire Bay', 'navy', 350, [35, 175, 500, 1100, 1300, 1500]),
  { type: 'tax', name: 'Wealth Tax', amount: 100 },
  S('Crown Point', 'navy', 400, [50, 200, 600, 1400, 1700, 2000]),
];

SPACES.forEach((s, i) => { s.index = i; });

const OWNABLE = new Set(['street', 'transit', 'utility']);
const JAIL_INDEX = 10;
const GROUP_MEMBERS = {};
SPACES.forEach((s) => {
  if (s.type === 'street') (GROUP_MEMBERS[s.group] ||= []).push(s.index);
});
const TRANSITS = SPACES.filter((s) => s.type === 'transit').map((s) => s.index);
const UTILITIES = SPACES.filter((s) => s.type === 'utility').map((s) => s.index);

// Approximate long-run chance that a given player lands on each space in one turn (jail-weighted).
// Used by the AI to value property and by the bank to value players' rent income.
const LAND = [0.031, 0.021, 0.019, 0.022, 0.024, 0.029, 0.023, 0.009, 0.023, 0.023,
  0.063, 0.027, 0.026, 0.024, 0.025, 0.029, 0.028, 0.026, 0.029, 0.031,
  0.028, 0.028, 0.011, 0.027, 0.032, 0.031, 0.027, 0.027, 0.028, 0.026,
  0.000, 0.027, 0.026, 0.024, 0.025, 0.024, 0.009, 0.022, 0.022, 0.026];

module.exports = { GROUPS, SPACES, OWNABLE, JAIL_INDEX, GROUP_MEMBERS, TRANSITS, UTILITIES, LAND };

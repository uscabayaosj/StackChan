import { expect, it } from 'vitest';
import { parseBusRequest, parseRailRequest } from '../src/transport_request.js';

it('preserves the stop, letter and direction from the transcript', () => {
  const request = parseBusRequest('Show me live bus arrivals at Clapham Common, stop D towards Stockwell.');
  expect(request).toEqual({ mode: 'bus', stop: 'Clapham Common, stop D towards Stockwell' });
  expect(parseBusRequest('What about the 50?', request)).toEqual({ ...request, route: '50' });
  expect(parseBusRequest('Towards Brixton?', request)).toEqual({ ...request, direction: 'Brixton' });
  expect(parseBusRequest('Stop E.', request)).toEqual({ ...request, letter: 'E' });
  expect(parseBusRequest('50')).toBeUndefined();
  expect(parseBusRequest('Buses from Clapham Common tomorrow')).toBeUndefined();
});

it.each([
  ['When is the next northbound bus arriving?', 'C'],
  ['When is the next southbound bus arriving?', 'J'],
  ['When’s the next south-bound bus coming?', 'J'],
  ['Show me north bound bus arrivals, please.', 'C'],
])('defaults %j to Elms Road Stop %s', (speech, letter) => {
  expect(parseBusRequest(speech, { mode: 'bus', stop: 'Victoria', route: '24' })).toEqual({
    mode: 'bus', stop: 'Elms Road / Windmill on the Common', letter,
  });
});

it('applies the stop default only to unnamed live bus requests', () => {
  expect(parseBusRequest('When is the next northbound bus arriving at Victoria?')).toBeUndefined();
  expect(parseBusRequest('When is the next northbound Tube arriving?')).toBeUndefined();
  expect(parseBusRequest('When is the first southbound bus arriving tomorrow?')).toBeUndefined();
  const local = parseBusRequest('Next northbound bus');
  expect(parseBusRequest('What about the 155?', local)).toEqual({ ...local, route: '155' });
  expect(parseBusRequest('Stop J', local)).toEqual({ ...local, letter: 'J' });
});

it.each([
  'When is the next train from London Waterloo to Clapham Junction?',
  'When the next train from Waterloo to Clapham Junction is',
  'Show me trains from Waterloo to Clapham Junction, please.',
])('recognizes the live Waterloo to Clapham Junction journey in %j', speech => {
  expect(parseRailRequest(speech)).toEqual({ mode: 'rail', stop: 'WAT', destination_crs: 'CLJ' });
});

it('keeps the journey direction and leaves future timetable requests to the model', () => {
  expect(parseRailRequest('When is the next train from Clapham Junction to London Waterloo?'))
    .toEqual({ mode: 'rail', stop: 'CLJ', destination_crs: 'WAT' });
  expect(parseRailRequest('When is the next train from Waterloo to Clapham Junction tomorrow?')).toBeUndefined();
  expect(parseRailRequest('When is the last train from Waterloo to Clapham Junction?')).toBeUndefined();
});

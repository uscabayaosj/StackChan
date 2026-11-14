import { expect, it } from 'vitest';
import { parseBusRequest } from '../src/transport_request.js';

it('preserves the stop, letter and direction from the transcript', () => {
  const request = parseBusRequest('Show me live bus arrivals at Clapham Common, stop D towards Stockwell.');
  expect(request).toEqual({ mode: 'bus', stop: 'Clapham Common, stop D towards Stockwell' });
  expect(parseBusRequest('What about the 50?', request)).toEqual({ ...request, route: '50' });
  expect(parseBusRequest('Towards Brixton?', request)).toEqual({ ...request, direction: 'Brixton' });
  expect(parseBusRequest('Stop E.', request)).toEqual({ ...request, letter: 'E' });
  expect(parseBusRequest('50')).toBeUndefined();
  expect(parseBusRequest('Buses from Clapham Common tomorrow')).toBeUndefined();
});

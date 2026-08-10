import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetRouterForTests,
  currentRoute,
  getRouterTeamSlug,
  navigate,
  setRouterTeamSlug,
} from '../src/lib/router.js';

describe('router', () => {
  beforeEach(() => {
    __resetRouterForTests();
  });

  it('boots to home by default', () => {
    expect(currentRoute.value).toEqual({ kind: 'home' });
  });

  it('navigate updates the signal and the URL', () => {
    navigate({ kind: 'tool-sources' });
    expect(currentRoute.value).toEqual({ kind: 'tool-sources' });
    expect(window.location.pathname).toBe('/tools');
  });

  it('navigate no-ops when target matches current', () => {
    navigate({ kind: 'tool-sources' });
    const historyLenBefore = window.history.length;
    navigate({ kind: 'tool-sources' });
    expect(window.history.length).toBe(historyLenBefore);
  });

  it('navigate with replace does not add to history', () => {
    const before = window.history.length;
    navigate({ kind: 'inbox' }, { replace: true });
    expect(currentRoute.value).toEqual({ kind: 'inbox' });
    expect(window.location.pathname).toBe('/inbox');
    expect(window.history.length).toBe(before);
  });

  it('popstate updates the signal from the URL', () => {
    navigate({ kind: 'tool-sources' });
    navigate({ kind: 'thread-channel', slug: 'general' });
    expect(currentRoute.value).toEqual({ kind: 'thread-channel', slug: 'general' });
    // Simulate back button: change the URL + dispatch popstate.
    window.history.replaceState(null, '', '/tools');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(currentRoute.value).toEqual({ kind: 'tool-sources' });
  });

  describe('team slug prefix', () => {
    it('setRouterTeamSlug + navigate emits /t/<slug>/... URLs', () => {
      setRouterTeamSlug('acme');
      navigate({ kind: 'tool-sources' });
      expect(window.location.pathname).toBe('/t/acme/tools');
      expect(currentRoute.value).toEqual({ kind: 'tool-sources', team: 'acme' });
    });

    it('explicit team on the route overrides the active slug', () => {
      setRouterTeamSlug('acme');
      navigate({ kind: 'inbox', team: 'widgetco' });
      expect(window.location.pathname).toBe('/t/widgetco/inbox');
    });

    it('getRouterTeamSlug reads back the active prefix', () => {
      expect(getRouterTeamSlug()).toBeNull();
      setRouterTeamSlug('acme');
      expect(getRouterTeamSlug()).toBe('acme');
    });

    it('clearing the slug returns to origin-rooted URLs', () => {
      setRouterTeamSlug('acme');
      navigate({ kind: 'tool-sources' });
      setRouterTeamSlug(null);
      navigate({ kind: 'members' });
      expect(window.location.pathname).toBe('/members');
    });

    it('__resetRouterForTests clears the slug', () => {
      setRouterTeamSlug('acme');
      __resetRouterForTests();
      expect(getRouterTeamSlug()).toBeNull();
    });
  });
});

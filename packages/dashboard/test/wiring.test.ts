import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The dashboard's wiring of the forecast, checked on its source: no test renders the page.
const source = readFileSync(new URL('../src/react/Dashboard.tsx', import.meta.url), 'utf8')

describe('Dashboard wiring', () => {
  it("keeps the page's requests to a few in flight", () => {
    expect(source).toMatch(
      /createPollStore\(limitRequests\(\(url, init\) => fetch\(url, init\), MAX_REQUESTS_IN_FLIGHT\)\)/,
    )
  })

  it('keeps the last used-share readings while the next range loads', () => {
    expect(source).toMatch(/const usedData = useLastReady\(usedReadings\)/)
    expect(source).toMatch(/failureOf\(usedReadings\)/)
  })

  it('colors the tokens chart from the subscriptions alone, as everywhere else', () => {
    // With the shown keys (the paid API among them) in the list, every subscription shifted.
    expect(source).toMatch(/seriesColors\(\s*knownProfiles,\s*folded\.map/)
  })

  it('shows one forecast: no per-window forecast beside the joint one', () => {
    // Two models on one page gave two different run-out times.
    expect(source).not.toMatch(/poolForecast\(/)
  })
})

const pool = readFileSync(new URL('../src/react/Pool.tsx', import.meta.url), 'utf8')

describe('Headline wiring', () => {
  it('reads the headline from one simulation of both windows, from the readings time', () => {
    expect(source).toMatch(/const asOf = snapshot\?\.asOf \?\? gapsAt/)
    // On the subscriptions as the forecast sees them: the poll's 100% leaves a little where
    // Anthropic has not refused (forecastProfiles).
    expect(source).toMatch(/forecastProfiles\(profilesNow, gapsAt\)/)
    // From the later of the readings and the clock: the last percent counts from now.
    expect(source).toMatch(/const forecastFrom = Math\.max\(asOf, gapsAt\)/)
    // The pace measured at the readings, the forecast run from the clock.
    expect(source).toMatch(/poolGaps\(forecastable, asOf, smoothed, gapsAt\)\.pace/)
    // At the pool's pace, from both windows' readings: the forecast and the advice alike.
    expect(source).toMatch(
      /poolRates\(usedData \?\? \[\], fiveData \?\? \[\], smoothingRange\.end\)/,
    )
    expect(source).toMatch(/useReadings\(apiBase, readingsQuery\(now, 'fiveHourUsed'\)\)/)
    expect(source).toMatch(
      /poolPace\(poolGaps\(forecastable, asOf, smoothed, gapsAt\)\.pace, rates\)/,
    )
    expect(source).toMatch(/poolPace\(poolGaps\(profiles, asOf, smoothed, at\)\.pace, rates\)/)
    expect(source).toMatch(/poolGaps\(forecastable, forecastFrom, smoothed, gapsAt, false, pace\)/)
    expect(source).toMatch(
      /<PoolOutlook\s+gaps=\{gaps\}\s+gapsIfStopped=\{gapsIfStopped\}\s+profiles=\{profilesNow\}/,
    )
    // The other tab: the same forecast with no more use.
    expect(source).toMatch(/poolGaps\(forecastable, forecastFrom, smoothed, gapsAt, true\)/)
    expect(pool).toMatch(/gapsHeadline\(props\.gaps, now\)/)
    expect(pool).not.toMatch(/forecastHeadline\(/)
  })

  it('puts the token and range controls just above the charts and table, not in the header', () => {
    const header = source.slice(source.indexOf('<header'), source.indexOf('</header>'))
    expect(header).not.toMatch(/tokenControl|rangeControl/)
    const toolbar = source.indexOf('cmd-toolbar')
    expect(toolbar).toBeGreaterThan(source.indexOf('aria-label="Traffic"'))
    expect(toolbar).toBeLessThan(source.indexOf('<div className="cmd-charts">'))
  })

  it('puts the subscriptions in detail last, below the charts and the breakdown', () => {
    const subscriptions = source.indexOf('aria-labelledby="cmd-subscriptions"')
    expect(subscriptions).toBeGreaterThan(source.indexOf('<Breakdown'))
    expect(subscriptions).toBeGreaterThan(source.indexOf('<div className="cmd-charts">'))
  })
})

const breakdown = readFileSync(new URL('../src/react/Breakdown.tsx', import.meta.url), 'utf8')
const queries = readFileSync(new URL('../src/react/queries.ts', import.meta.url), 'utf8')

describe('Token wiring', () => {
  it('charts tokens by subscription, and requests only when the range has no token counts', () => {
    expect(source).toMatch(/useCountedSeries\(apiBase, tokensByProfileQuery\(now, rangeName\)\)/)
    expect(source).toMatch(/tokensOfType\(tokensByProfileTypes, tokenChoice\)/)
    expect(source).toMatch(
      /const showTokens = tokenRangeCoverage !== null && tokenRangeCoverage !== 'none'/,
    )
    expect(source).toMatch(/No token counts for this range yet; showing requests\./)
  })

  it('keeps models on requests, and shows a failed token query as an error', () => {
    expect(queries).toMatch(/dimension: 'model',\s+label: 'Models'.*tokens: false/s)
    // Projects count tokens only: no requests fallback to ask for.
    expect(queries).toMatch(/dimension: 'project',[^}]*tokens: true,\s+requests: false/s)
    expect(breakdown).toMatch(/does not count tokens by model; this view counts requests/)
    expect(breakdown).toMatch(/tokensPending \|\| tokenError !== null \? \[\] : requestRows/)
    // The title names the range the token totals cover.
    expect(breakdown).toMatch(/\{tableRangeWords\(\s*showTokens \? coverage : null,/)
  })

  it('keeps the breakdown body at its last height while another split or range loads', () => {
    expect(breakdown).toMatch(/useHeldHeight<HTMLDivElement>\(loading\)/)
    // The loading note, the chart and the table are all inside the held body.
    const body = breakdown.slice(breakdown.indexOf('ref={bodyRef}'))
    expect(body).toMatch(/minHeight: heldHeight/)
    for (const part of ['Loading…', 'cmd-breakdown-chart', '<table']) {
      expect(body.indexOf(part)).toBeGreaterThan(-1)
    }
  })
})

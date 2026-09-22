/**
 * Step one — choose the trade.
 *
 * The journey begins with a real invoice, never with "how much do you want?".
 * There is no free-text amount input on this screen and there must not be one:
 * the trade determines the amount, which is the Shariah structure made visible
 * in the interface and the clearest single departure from a conventional
 * lending journey (FP-02, BR-D01, SDD §7.4.1).
 *
 * Invoices that cannot be financed are shown greyed with their reason rather
 * than hidden. Someone who cannot see why an option is missing assumes the
 * system is broken, or worse, tries to work around it.
 */

import { Card, ControlRejection, DualDate, Status } from '../design/primitives.tsx';
import { formatMinorUnits } from '../design/Money.tsx';
import { STRINGS, isRtl } from '../i18n/strings.ts';
import { availableLimitMinorUnits, listTrades } from '../server/trades.ts';

const LOCALE = 'ar-SA' as const;

export default async function ChooseTheTradePage() {
  const t = STRINGS[LOCALE];
  const [limit, trades] = await Promise.all([availableLimitMinorUnits(), listTrades()]);
  const numerals = isRtl(LOCALE) ? 'arabic-indic' : 'latin';

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-card bg-brand-wash p-4">
        <p className="text-sm text-ink-quiet">{t.availableLimit}</p>
        <p className="mt-1 text-amount font-semibold text-ink tabular-nums">
          <bdi>{formatMinorUnits({ minorUnits: limit, currency: 'SAR' }, numerals)}</bdi>{' '}
          <span className="text-sm text-ink-quiet">SAR</span>
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <h1 className="text-lg font-semibold">{t.chooseTheTrade}</h1>
          <p className="mt-1 text-sm text-ink-quiet">{t.chooseTheTradeHelp}</p>
        </div>

        {trades.length === 0 ? (
          <Card>
            <p className="font-medium">{t.noTradesTitle}</p>
            <p className="mt-1 text-sm text-ink-quiet">{t.noTradesBody}</p>
          </Card>
        ) : null}

        <ul className="flex list-none flex-col gap-3 p-0">
          {trades.map((trade) => {
            const blocked = trade.availability.kind === 'BLOCKED';

            return (
              <li key={trade.transactionId}>
                <Card muted={blocked}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-col gap-1">
                      <span className="text-sm text-ink-quiet">
                        {t.invoice} <span className="identifier">{trade.invoiceNumber}</span>
                      </span>
                      <span className="font-medium">{trade.buyerNameAr}</span>
                      <DualDate
                        gregorian={trade.issuedGregorian}
                        hijri={trade.issuedHijri}
                        locale={LOCALE}
                      />
                    </div>

                    <div className="flex flex-col items-end gap-2">
                      <span className="text-base font-semibold tabular-nums">
                        <bdi>
                          {formatMinorUnits(
                            { minorUnits: trade.amountMinorUnits, currency: trade.currency },
                            numerals,
                          )}
                        </bdi>{' '}
                        <span className="text-xs text-ink-quiet">{trade.currency}</span>
                      </span>
                      <Status
                        tone={blocked ? 'blocked' : 'available'}
                        label={blocked ? t.alreadyFinanced : t.availableForFinance}
                      />
                    </div>
                  </div>

                  {trade.availability.kind === 'BLOCKED' ? (
                    <div className="mt-3">
                      <ControlRejection
                        control={trade.availability.control}
                        explanation={trade.availability.reason}
                        controlLabel={t.blockedBy}
                      />
                    </div>
                  ) : (
                    <a
                      href={`/finance/${trade.transactionId}`}
                      className="mt-3 inline-flex min-h-tap w-full items-center justify-center rounded-card border border-brand-strong px-4 text-base font-semibold text-brand-deep hover:bg-brand-wash"
                    >
                      {t.murabahaOffer}
                    </a>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

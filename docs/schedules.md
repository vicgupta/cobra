# Schedules

A task runs on a schedule you pick in the task form (Tasks → New task or Edit → **Schedule**). Pick a preset, or pick **Custom** and type a cron schedule. The line under the field says in plain words when it will run.

**All times are Eastern (ET, America/New_York), and follow daylight saving time.** They are not UTC and not the server's clock.

## Presets

| Label | Cron | Runs |
|---|---|---|
| Not scheduled | (none) | Only when you click Run |
| Every 15 minutes | `*/15 * * * *` | At :00, :15, :30 and :45 of every hour |
| Every 30 minutes | `*/30 * * * *` | At :00 and :30 of every hour |
| Every hour | `0 * * * *` | On the hour, every hour (you can pick the minute) |
| Every 2 hours | `0 */2 * * *` | On the hour, every 2 hours from midnight |
| Every 4 hours | `0 */4 * * *` | At 0:00, 4:00, 8:00, 12:00, 16:00 and 20:00 |
| Every even hour | `0 0-22/2 * * *` | At 0:00, 2:00 … 22:00 (same times as every 2 hours) |
| Every odd hour | `0 1-23/2 * * *` | At 1:00, 3:00 … 23:00 |
| Once a day | `0 9 * * *` | Every day at the time you pick (default 9:00) |
| Weekdays only | `0 9 * * 1-5` | Monday to Friday at the time you pick (default 9:00) |
| Once a week | `0 9 * * 1` | One day a week at the time you pick |
| Custom | any 5 values | Whatever you type |

## Writing a custom schedule

A schedule is five values separated by spaces:

1. **minute** (0–59)
2. **hour** (0–23)
3. **day of month** (1–31)
4. **month** (1–12)
5. **day of week** (0–7; Sunday is 0, and 7 is also Sunday)

In each value, `*` means every, `*/n` means every n, `a-b` is a range, and `a,b` is a list. When you set both day of month and day of week, the task runs when either one matches.

## Examples

All times are Eastern (ET).

| Cron | Runs |
|---|---|
| `0 6 * * *` | Every day at 6:00 |
| `0 9,17 * * 1-5` | 9:00 and 17:00 on weekdays |
| `15 */3 * * *` | Every 3 hours at quarter past |
| `0 0 1 * *` | Midnight on the 1st of each month |
| `0 12 * * 0` | Every Sunday at noon |
| `0 8-18 * * 1-5` | Every hour 8:00–18:00 on weekdays |

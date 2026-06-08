#pragma once
typedef long long time_t;
typedef long clock_t;
struct tm {
  int tm_sec, tm_min, tm_hour, tm_mday, tm_mon, tm_year;
  int tm_wday, tm_yday, tm_isdst;
};
#define CLOCKS_PER_SEC 1000
clock_t clock(void);
time_t time(time_t *);
double difftime(time_t, time_t);
struct tm *localtime(const time_t *);
struct tm *gmtime(const time_t *);
char *asctime(const struct tm *);
char *ctime(const time_t *);


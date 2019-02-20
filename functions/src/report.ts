import { format } from "date-fns";
import { readFileSync } from "fs";
import * as functions from "firebase-functions";
import * as path from "path";
import * as mustache from "mustache";

import { database } from "./database";
import * as email from "./email";
import * as snap from "./snapshot";
import * as util from "./util";
import { snapshot, report } from "./types";
import { BotConfig, getFunctionsConfig } from "./config";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Used for duck-typing objects for calculating a SAM Score.
 */
interface SAMScoreable {
  open_issues_count: number;
  closed_issues_count: number;
}

/**
 * Function that filters issues.
 */
interface IssueFilter {
  (issue: snapshot.Issue): boolean;
}

/**
 * Function that filters repos.
 */
interface RepoFilter {
  (repo: snapshot.Repo): boolean;
}

const snapshotsRef = database.ref("snapshots/github");

const email_client = new email.EmailClient(
  getFunctionsConfig("mailgun.key"),
  getFunctionsConfig("mailgun.domain")
);

// Config
// TODO: This should be a singleton
const config_json = getFunctionsConfig("runtime.config");
const bot_config = new BotConfig(config_json);

const EMAIL_DEBUG = getFunctionsConfig("email.debug") === "true";
const EMAIL_GROUP = getFunctionsConfig("email.recipient");

export async function GetWeeklyReport(org: string) {
  // Grab the most recent daily snapshot
  const recentEntrySnapshot = await snapshotsRef
    .limitToLast(1)
    .once("child_added");
  const recentEntry = (await recentEntrySnapshot.val()) as snapshot.Org;

  // Count repos
  const totalPublicRepos = recentEntry.public_repos;
  const publicReposInSnapshot = CountReposWithFilter(
    recentEntry,
    (repo: snapshot.Repo) => {
      return !repo.private;
    }
  );

  if (totalPublicRepos != publicReposInSnapshot) {
    console.warn(
      `API says ${totalPublicRepos} but there are ${publicReposInSnapshot} in snapshot.`
    );
  } else {
    console.log(`Total public repos: ${totalPublicRepos}`);
  }

  // Repos with highest and lowest SAM scores
  const topSAMs = GetHighestSam(recentEntry);
  const bottomSAMs = GetLowestSam(recentEntry);

  // Repos with most stars and most open issues
  const topStars = GetTopStars(recentEntry);
  const topIssues = GetTopIssues(recentEntry);

  // Counting open PRs and Issues (total0)
  const totalOpenPullRequests = GetTotalOpenPullRequests(recentEntry);
  const totalOpenIssues = GetTotalOpenIssues(recentEntry);

  // Issues with no comments at all
  const totalOpenIssuesWithNoComments = GetTotalOpenIssuesWithNoComments(
    recentEntry
  );

  // Total stars for the org and total SAM score for the org
  const totalStars = GetTotalStars(recentEntry);
  const totalSAM = GetTotalSamScore(recentEntry);

  // Issues per repo
  const averageIssuesPerRepo = Math.floor(totalOpenIssues / totalPublicRepos);

  return {
    topSAMs,
    bottomSAMs,
    topStars,
    topIssues,
    totalOpenIssues,
    totalOpenIssuesWithNoComments,
    totalOpenPullRequests,
    totalPublicRepos,
    totalStars,
    totalSAM,
    averageIssuesPerRepo
  };
}

function GetTotalOpenIssues(snapshot: snapshot.Org) {
  if (!snapshot) {
    return 0;
  }

  return CountIssuesWithFilter(snapshot, (issue: snapshot.Issue) => {
    return !issue.pull_request;
  });
}

function GetTotalStars(org: snapshot.Org) {
  if (!org) return 0;

  return Object.keys(org.repos).reduce((sum, key) => {
    return sum + org.repos[key].stargazers_count;
  }, 0);
}

function GetTotalSamScore(org: snapshot.Org) {
  const sumOfRepos = Object.keys(org.repos)
    .map((repoKey: string) => {
      const repo = org.repos[repoKey];

      if (repo.open_issues_count == undefined) {
        console.warn(`Repo ${repoKey} has null open issues count.`);
      }

      if (repo.closed_issues_count == undefined) {
        console.warn(`Repo ${repoKey} has null closed issues count.`);
      }

      return {
        open_issues_count: repo.open_issues_count || 0,
        closed_issues_count: repo.closed_issues_count || 0
      };
    })
    .reduce((a: SAMScoreable, b: SAMScoreable) => {
      return {
        open_issues_count: a.open_issues_count + b.open_issues_count,
        closed_issues_count: a.closed_issues_count + b.closed_issues_count
      };
    });

  return ComputeSAMScore(sumOfRepos);
}

function CountReposWithFilter(org: snapshot.Org, filter: RepoFilter): number {
  let count = 0;
  Object.keys(org.repos).forEach(repoKey => {
    const repo = org.repos[repoKey];

    if (filter(repo)) {
      count++;
    }
  });

  return count;
}

function CountIssuesWithFilter(org: snapshot.Org, filter: IssueFilter) {
  let matchingIssues = 0;

  Object.keys(org.repos).forEach(repoKey => {
    const repo = org.repos[repoKey];

    if (repo.private) {
      return;
    }

    matchingIssues += Object.keys(repo.issues || {}).reduce(
      (sum, issue_id: string) => {
        const issue = repo.issues[issue_id];

        if (filter(issue)) {
          return sum + 1;
        } else {
          return sum;
        }
      },
      0
    );
  });

  return matchingIssues;
}

function GetTotalOpenIssuesWithNoComments(snapshot: snapshot.Org) {
  if (!snapshot) {
    return 0;
  }

  return CountIssuesWithFilter(snapshot, (issue: snapshot.Issue) => {
    return !issue.pull_request && !issue.comments;
  });
}

function GetTotalOpenPullRequests(snapshot: snapshot.Org) {
  if (!snapshot) {
    return 0;
  }

  return CountIssuesWithFilter(snapshot, (issue: snapshot.Issue) => {
    return issue.pull_request;
  });
}

function GetSortedSam(
  org: snapshot.Org,
  sortFn: (x: any, y: any) => number,
  count?: number
) {
  let sortedSAM = Object.keys(org.repos)
    .map((repoKey: string) => {
      const repo = org.repos[repoKey];
      const name = repo.name;
      const sam = ComputeSAMScore(repo);
      return { name, sam };
    })
    .sort(sortFn)
    .filter(repo => {
      return repo.sam > 0;
    });

  if (count) sortedSAM = sortedSAM.slice(0, count);
  return sortedSAM;
}

function GetLowestSam(org: snapshot.Org, count?: number) {
  return GetSortedSam(
    org,
    (a, b) => {
      return a.sam - b.sam;
    },
    count
  );
}

function GetHighestSam(org: snapshot.Org, count?: number) {
  return GetSortedSam(
    org,
    (a, b) => {
      return b.sam - a.sam;
    },
    count
  );
}

function GetTopStars(org: snapshot.Org, count?: number) {
  let topStars = Object.keys(org.repos)
    .map((repoKey: string) => {
      const repo = org.repos[repoKey];
      const name = repo.name;
      const stars = repo.stargazers_count;
      return { name, stars };
    })
    .sort((a, b) => {
      return b.stars - a.stars;
    });

  if (count) topStars = topStars.slice(0, count);
  return topStars;
}

function GetTopIssues(org: snapshot.Org, count?: number) {
  let topIssues = Object.keys(org.repos)
    .map((repoKey: string) => {
      const repo = org.repos[repoKey];
      const name = repo.name;
      const issues = repo.open_issues_count;
      return { name, issues };
    })
    .sort((a, b) => {
      return b.issues - a.issues;
    });

  if (count) topIssues = topIssues.slice(0, count);
  return topIssues;
}

export function ComputeSAMScore(repo: SAMScoreable) {
  const open_issues = repo.open_issues_count || 0;
  const closed_issues = repo.closed_issues_count || 0;

  if (!closed_issues) {
    return 0;
  }

  return (
    (open_issues / (open_issues + closed_issues)) *
    Math.log(Math.E + open_issues + closed_issues)
  );
}

async function FetchClosestSnapshot(org: string, repo: string, date: Date) {
  // Try to get a snapshot within 3 days of the requested date
  // (moving backwards iteratively).
  for (let i = 0; i < 2; i++) {
    const msOffset = DAY_MS * i;
    const offsetDate = new Date(date.getTime() - msOffset);

    const snapshot = await snap.FetchRepoSnapshot(org, repo, offsetDate);
    if (snapshot) {
      return {
        date: offsetDate,
        snapshot
      };
    } else {
      console.warn(`Could not get snapshot for ${repo} on ${date}`);
    }
  }

  return {
    date: date,
    snapshot: undefined
  };
}

export async function MakeRepoReport(
  org: string,
  repo: string
): Promise<report.Repo> {
  // Get two snapshots
  const now = new Date();

  // Use yesterday and 7 days ago in case today's snapshot job
  // has not run yet.
  const startDate = new Date(now.getTime() - DAY_MS);
  const endDate = new Date(startDate.getTime() - 7 * DAY_MS);

  const after = await FetchClosestSnapshot(org, repo, startDate);
  const afterDate = after.date;
  const afterSnap = after.snapshot;

  const before = await FetchClosestSnapshot(org, repo, endDate);
  const beforeDate = before.date;
  const beforeSnap = before.snapshot;

  if (!afterSnap) {
    throw `Couldn't get 'after' snapshot for ${startDate}`;
  }

  if (!beforeSnap) {
    throw `Couldn't get 'before' snapshot for ${endDate}`;
  }

  // Simple counting stats
  const open_issues = new report.Diff(
    beforeSnap.open_issues_count,
    afterSnap.open_issues_count
  );
  const stars = new report.Diff(
    beforeSnap.stargazers_count,
    afterSnap.stargazers_count
  );
  const forks = new report.Diff(beforeSnap.forks_count, afterSnap.forks_count);

  // SAM Score
  const sam = new report.Diff(
    ComputeSAMScore(beforeSnap),
    ComputeSAMScore(afterSnap)
  );

  // Check for difference in issues
  const before_ids = Object.keys(beforeSnap.issues);
  const after_ids = Object.keys(afterSnap.issues);

  // TODO: Should probably move this to Utils
  function setDiff<T>(a: T[], b: T[]) {
    return a.filter((x: T) => {
      return b.indexOf(x) < 0;
    });
  }

  // TODO: This could be moved out
  function toChangedIssue(issue: snapshot.Issue): report.ChangedIssue {
    return {
      number: issue.number,
      title: issue.title,
      link: `https://github.com/firebase/${repo}/issues/${issue.number}`
    };
  }

  // Issues present in only the "before" snap are newly closed, issues present in only
  // the "after" snap are newly opened.
  const closed_issues: report.ChangedIssue[] = setDiff(
    before_ids,
    after_ids
  ).map(id => {
    const issue = beforeSnap.issues[id];
    return toChangedIssue(issue);
  });
  const opened_issues: report.ChangedIssue[] = setDiff(
    after_ids,
    before_ids
  ).map(id => {
    const issue = afterSnap.issues[id];
    return toChangedIssue(issue);
  });

  return {
    name: repo,

    start: util.DateSlug(beforeDate),
    end: util.DateSlug(afterDate),

    sam,
    open_issues,
    stars,
    forks,

    opened_issues,
    closed_issues
  };
}

/**
 * HTTP Function to get a JSON report on a repo.
 */
export const GetRepoReport = functions
  .runWith(util.FUNCTION_OPTS)
  .https.onRequest(async (req, res) => {
    // TODO: Allow passing in the 'start' date to get historical data.

    // TODO: Make this a parameter
    const org = "firebase";
    const repo = req.param("repo");
    if (repo === undefined) {
      res.status(500).send("Must specify 'repo' param");
      return;
    }

    try {
      const report = await MakeRepoReport(org, repo);
      res.status(200).send(JSON.stringify(report));
    } catch (e) {
      res.status(500).send(e);
    }
  });

/**
 * PubSub function that saves the weekly report to RTDB.
 */
export const SaveWeeklyReport = functions
  .runWith(util.FUNCTION_OPTS)
  .pubsub.topic("save_weekly_report")
  .onPublish(async (message: functions.pubsub.Message) => {
    const now = new Date();

    // Save firebase report to the DB
    const report = await GetWeeklyReport("firebase");
    return database
      .ref("reports")
      .child("github")
      .child(util.DateSlug(now))
      .set(report);
  });

/**
 * PubSub function that sends the Github email based on the latest weekly report.
 */
export const SendWeeklyEmail = functions.pubsub
  .topic("send_weekly_email")
  .onPublish(async event => {
    const emailText = await GetWeeklyEmail("firebase");
    const now = new Date();

    const dateString = format(now, "MM/DD/YY");
    const subject = `Firebase Github Summary for ${dateString}`;

    await email_client.sendEmail(EMAIL_GROUP, subject, emailText);
  });

/**
 * PubSub function that sends the Github email based on the latest weekly report.
 */
export const SendWeeklyRepoEmails = functions.pubsub
  .topic("send_weekly_repo_email")
  .onPublish(async event => {
    const allRepos = bot_config.getAllRepos();
    for (const repo of allRepos) {
      const reportConfig = bot_config.getRepoReportingConfig(
        repo.org,
        repo.name
      );
      if (!reportConfig) {
        console.log(`No reporting config for ${repo.name}`);
        continue;
      }

      if (EMAIL_DEBUG) {
        console.warn(`Debug mode, redirecting emails for ${repo.name}`);
        reportConfig.email = EMAIL_GROUP;
      }

      const emailText = await GetWeeklyRepoEmail(repo.org, repo.name);
      const dateString = format(new Date(), "MM/DD/YY");
      const subject = `${repo.name} Github Summary for ${dateString}`;

      console.log(`Sending email for ${repo.name} to ${reportConfig.email}`);
      await email_client.sendEmail(reportConfig.email, subject, emailText);
    }
  });

export async function GetWeeklyRepoEmail(org: string, repo: string) {
  const report = await MakeRepoReport(org, repo);

  const template = readFileSync(path.join(__dirname, "./repo-weekly.mustache"));
  return mustache.render(template.toString(), report);
}

export async function GetWeeklyEmail(org: string) {
  // Originally the bot was designed only to scrape Firebase so the
  // reports were stored just under reports/github. This is special-cased.
  const reportsChild = org === "firebase" ? "github" : org;

  const reportSnapshot = await database
    .ref("reports")
    .child(reportsChild)
    .limitToLast(1)
    .once("child_added");
  const report = reportSnapshot.val();

  const previousReportSnapshot = await database
    .ref("reports")
    .child(reportsChild)
    .limitToLast(2)
    .once("child_added");
  const previousReport = previousReportSnapshot.val();

  Object.keys(report).forEach(key => {
    if (typeof report[key] !== "number") return;
    const keyDiff = `${key}Diff`;

    report[keyDiff] = report[key] - previousReport[key];

    if (report[keyDiff] >= 0) report[keyDiff] = `+${report[keyDiff]}`;
  });

  report.topSAMs = report.topSAMs.slice(0, 10);
  report.bottomSAMs = report.bottomSAMs.slice(0, 10);
  report.topStars = report.topStars.slice(0, 5);
  report.topIssues = report.topIssues.slice(0, 5);

  report.topSAMs.forEach((entry: any, index: number) => {
    entry.index = index + 1;
    entry.sam = entry.sam.toPrecision(3);
  });

  report.bottomSAMs.forEach((entry: any, index: number) => {
    entry.index = index + 1;
    entry.sam = entry.sam.toPrecision(3);
  });

  report.topStars.forEach((entry: any, index: number) => {
    entry.index = index + 1;
  });

  report.topIssues.forEach((entry: any, index: number) => {
    entry.index = index + 1;
  });

  const template = readFileSync(path.join(__dirname, "./weekly.mustache"));
  return mustache.render(template.toString(), report);
}

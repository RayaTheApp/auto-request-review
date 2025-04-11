'use strict';

const core = require('@actions/core');
const { LOCAL_FILE_MISSING } = require('./constants');
const github = require('./github'); // Don't destructure this object to stub with sinon in tests

const {
  fetch_other_group_members,
  identify_reviewers_by_changed_files,
  identify_reviewers_by_author,
  should_request_review,
  fetch_default_reviewers,
  randomly_pick_reviewers,
  randomly_pick_assignees_from_list,
} = require('./reviewer');

async function run() {
  core.info('Fetching configuration file from the source branch');

  let config;

  try {
    config = await github.fetch_config();
  } catch (error) {
    if (error.status === 404) {
      core.warning('No configuration file is found in the base branch; terminating the process');
      return;
    }

    if (error.message === LOCAL_FILE_MISSING) {
      core.warning('No configuration file is found locally; terminating the process');
      return;
    }

    throw error;
  }

  // Initialize options if it doesn't exist
  config.options = config.options || {};
  const { ignored_reviewers = '' } = config.options;
  const { title, is_draft, author, requested_reviewer_usernames, assignee_usernames } = github.get_pull_request();

  if (!should_request_review({ title, is_draft, config })) {
    core.info('Matched the ignoring rules; terminating the process');
    return;
  }

  core.info(`Requested reviewer usernames found: ${requested_reviewer_usernames}`);
  core.info(`Assigned reviewer usernames found: ${assignee_usernames}`);
  core.info(`Ignored reviewers found: ${ignored_reviewers}`);

  core.info('Fetching changed files in the pull request');
  const changed_files = await github.fetch_changed_files();

  core.info('Identifying reviewers based on the changed files');
  const reviewers_based_on_files = identify_reviewers_by_changed_files({ config, changed_files, excludes: [ author ] });
  core.info('Identified: ' + JSON.stringify(reviewers_based_on_files));

  core.info('Identifying reviewers based on the author');
  const reviewers_based_on_author = identify_reviewers_by_author({ config, author });
  core.info('Identified: ' + JSON.stringify(reviewers_based_on_author));

  core.info('Adding other group members to reviewers if group assignment feature is on');
  const reviewers_from_same_teams = fetch_other_group_members({ config, author });
  core.info('Added: ' + JSON.stringify(reviewers_from_same_teams));

  let reviewers = [ ...new Set([ ...reviewers_based_on_files, ...reviewers_based_on_author, ...reviewers_from_same_teams ]) ];
  core.info('Reviewers identified: ' + JSON.stringify(reviewers));

  core.info(`Config Options: ${JSON.stringify(config.options)}`);

  if (reviewers.length === 0) {
    core.info('Matched no reviewers');
    const default_reviewers = fetch_default_reviewers({ config, excludes: [ author ] });

    if (default_reviewers.length === 0) {
      core.info('No default reviewers are matched; terminating the process');
      return;
    }

    core.info('Falling back to the default reviewers: ' + JSON.stringify(default_reviewers));
    reviewers.push(...default_reviewers);
  }

  let all_requested_reviewers = [];
  if (requested_reviewer_usernames && requested_reviewer_usernames.length > 0) {
    core.info('Removing already requested reviewers: ' + JSON.stringify(requested_reviewer_usernames));
    const requestedReviewerSet = new Set(requested_reviewer_usernames);
    reviewers = reviewers.filter((reviewer) => !requestedReviewerSet.has(reviewer));
    core.info('Reviewers now: ' + JSON.stringify(reviewers));
    all_requested_reviewers = all_requested_reviewers.concat(requested_reviewer_usernames);
  }

  if (assignee_usernames && assignee_usernames.length > 0) {
    core.info('Removing already assigned reviewers: ' + JSON.stringify(assignee_usernames));
    const assigneeSet = new Set(assignee_usernames);
    reviewers = reviewers.filter((reviewer) => !assigneeSet.has(reviewer));
    core.info('Reviewers now: ' + JSON.stringify(reviewers));
  }

  if (ignored_reviewers && ignored_reviewers.length > 0) {
    core.info(`Removing ignored reviewers: ${ignored_reviewers}`);
    const ignoredSplit = ignored_reviewers.split(',');
    const ignoredSet = new Set(ignoredSplit);
    reviewers = reviewers.filter((rev) => !ignoredSet.has(rev));
    core.info(`Reviewers now: ${JSON.stringify(reviewers)}`);
    all_requested_reviewers = all_requested_reviewers.concat(ignoredSplit);
  }

  core.info('Randomly picking reviewers if the number of reviewers is set');
  const requested_reviewers = randomly_pick_reviewers({ reviewers, config });
  core.info(`Requesting reviewers: ${requested_reviewers.join(', ')}`);


  if (requested_reviewers && requested_reviewers.length > 0) {
    const requestedReviewersSet = new Set(requested_reviewers);
    reviewers = reviewers.filter((rev) => !requestedReviewersSet.has(rev));
    core.info(`Removing added requested reviewers to now have: ${reviewers}`);
    all_requested_reviewers = all_requested_reviewers.concat(requested_reviewers);
  }

  const number_of_assignees = config.options.number_of_assignees;
  core.info(`Adding number of Assignees: ${number_of_assignees}`);
  core.info(`Requested Reviewer Usernames: ${JSON.stringify(requested_reviewer_usernames)}`);
  core.info(`Newly Requested Reviewers: ${JSON.stringify(requested_reviewers)}`);
  core.info(`All Requested Reviewers: ${JSON.stringify(all_requested_reviewers)}`);

  // Add handling for ignored assignees
  const ignored_assignees = config.options.ignored_assignees;
  if (ignored_assignees && ignored_assignees.length > 0) {
    core.info(`Removing ignored assignees: ${ignored_assignees}`);
    const ignoredAssigneesSplit = ignored_assignees.split(',');
    const ignoredAssigneesSet = new Set(ignoredAssigneesSplit);
    all_requested_reviewers = all_requested_reviewers.filter((rev) => !ignoredAssigneesSet.has(rev));
    core.info(`Potential assignees after removing ignored: ${JSON.stringify(all_requested_reviewers)}`);
  }

  core.info(`Picking ${number_of_assignees} assignees from ${all_requested_reviewers}.`);
  const assigned_reviewers = randomly_pick_assignees_from_list({ reviewers: all_requested_reviewers, number_of_assignees });
  core.info(`Requesting assignees: ${JSON.stringify(assigned_reviewers)}`);

  await github.assign_reviewers(requested_reviewers);
  await github.assign_assignees(assigned_reviewers);
  core.setOutput('requested_reviewers', requested_reviewers.join(','));
  core.setOutput('assigned_reviewers', assigned_reviewers.join(','));
}

module.exports = {
  run,
};

// Run the action if it's not running in an automated testing environment
if (process.env.NODE_ENV !== 'automated-testing') {
  run().catch((error) => core.setFailed(error));
}

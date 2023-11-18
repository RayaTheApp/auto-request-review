'use strict';

const core = require('@actions/core');
const fs = require('fs');
const github = require('@actions/github');
const partition = require('lodash/partition');
const yaml = require('yaml');
const { LOCAL_FILE_MISSING } = require('./constants');

class PullRequest {
  // ref: https://developer.github.com/v3/pulls/#get-a-pull-request
  constructor(pull_request_payload) {
    // "ncc" doesn't yet support private class fields as of 29 Aug. 2020
    // ref: https://github.com/vercel/ncc/issues/499
    this._pull_request_payload = pull_request_payload;
  }

  get author() {
    return this._pull_request_payload.user.login;
  }

  get title() {
    return this._pull_request_payload.title;
  }

  get is_draft() {
    return this._pull_request_payload.draft;
  }

  get requested_reviewers() {
    return this._pull_request_payload.requested_reviewers;
  }

  get requested_reviewer_usernames() {
    return this.requested_reviewers.map((rev) => rev.login);
  }

  get assignees() {
    return this._pull_request_payload.assignees;
  }

  get assignee_usernames() {
    return this.assignees.map((rev) => rev.login);
  }
}

function get_pull_request() {
  const context = get_context();

  return new PullRequest(context.payload.pull_request);
}

async function fetch_config() {
  const context = get_context();
  const octokit = get_octokit();
  const config_path = get_config_path();
  const useLocal = get_use_local();
  const numberOfReviewers = get_number_of_reviewers();
  const numberOfAssignees = get_number_of_assignees();
  const ignoredReviewers = get_ignored_reviewers();

  core.info(`Received ${numberOfReviewers} reviewers, ${numberOfAssignees} assignees, and ${ignoredReviewers} ignored from inputs.`);

  let content = '';

  if (!useLocal) {
    const { data: response_body } = await octokit.repos.getContent({
      owner: context.repo.owner,
      repo: context.repo.repo,
      path: config_path,
      ref: context.ref,
    });

    content = Buffer.from(response_body.content, response_body.encoding).toString();
  } else {
    try {
      content = fs.readFileSync(config_path).toString();

      if (!content) {
        throw new Error();
      }
    } catch (error) {
      core.debug(`Error when reading local file: ${error}`);

      throw new Error(LOCAL_FILE_MISSING);
    }
  }

  const config = yaml.parse(content);
  if (numberOfReviewers) {
    config.options.number_of_reviewers = numberOfReviewers;
  }
  if (numberOfAssignees) {
    config.options.number_of_assignees = numberOfAssignees;
  }
  if (ignoredReviewers) {
    config.options.ignored_reviewers = ignoredReviewers;
  }

  core.info(`Final Fetched Config: ${JSON.stringify(config)}`);
  return config;
}

async function fetch_changed_files() {
  const context = get_context();
  const octokit = get_octokit();

  const changed_files = [];

  const per_page = 100;
  let page = 0;
  let number_of_files_in_current_page;

  do {
    page += 1;

    const { data: response_body } = await octokit.pulls.listFiles({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: context.payload.pull_request.number,
      page,
      per_page,
    });

    number_of_files_in_current_page = response_body.length;
    changed_files.push(...response_body.map((file) => file.filename));

  } while (number_of_files_in_current_page === per_page);

  return changed_files;
}

async function assign_reviewers(reviewers) {
  const context = get_context();
  const octokit = get_octokit();

  const [ teams_with_prefix, individuals ] = partition(reviewers, (reviewer) => reviewer.startsWith('team:'));
  const teams = teams_with_prefix.map((team_with_prefix) => team_with_prefix.replace('team:', ''));

  return octokit.pulls.requestReviewers({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: context.payload.pull_request.number,
    reviewers: individuals,
    team_reviewers: teams,
  });
}

async function assign_assignees(assignees) {
  const context = get_context();
  const octokit = get_octokit();
  return octokit.issues.addAssignees({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.payload.pull_request.number,
    assignees: assignees
  });
}

/* Private */

let context_cache;
let token_cache;
let config_path_cache;
let use_local_cache;
let octokit_cache;

function get_context() {
  return context_cache || (context_cache = github.context);
}

function get_token() {
  return token_cache || (token_cache = core.getInput('token'));
}

function get_config_path() {
  return config_path_cache || (config_path_cache = core.getInput('config'));
}

function get_use_local() {
  return use_local_cache ?? (use_local_cache = core.getInput('use_local') === 'true');
}

function get_ignored_reviewers() {
  return core.getInput('ignored_reviewers');
}

function get_number_of_reviewers() {
  return core.getInput('number_of_reviewers');
}

function get_number_of_assignees() {
  return core.getInput('number_of_assignees');
}

function get_octokit() {
  if (octokit_cache) {
    return octokit_cache;
  }

  const token = get_token();
  return octokit_cache = github.getOctokit(token);
}

function clear_cache() {
  context_cache = undefined;
  token_cache = undefined;
  config_path_cache = undefined;
  octokit_cache = undefined;
}

module.exports = {
  get_pull_request,
  fetch_config,
  fetch_changed_files,
  assign_reviewers,
  assign_assignees,
  clear_cache,
};

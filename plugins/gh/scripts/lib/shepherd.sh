#!/usr/bin/env bash
# lib/shepherd.sh — shared pieces of the shepherd scripts. Source it.
#
#   SHEPHERD_PR_FIELDS  the --json field list both scripts ask gh for
#   SHEPHERD_JQ         run jq with lib/ on the module path, so a program can
#                       `include "shepherd";` (see shepherd.jq)

# shellcheck disable=SC2034  # consumed by the scripts that source this file
SHEPHERD_PR_FIELDS='number,title,author,isDraft,labels,autoMergeRequest,mergeStateStatus,mergeable,headRefOid,statusCheckRollup,createdAt,state,mergeCommit'

SHEPHERD_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

shepherd_jq() { jq -L "$SHEPHERD_LIB_DIR" "$@"; }

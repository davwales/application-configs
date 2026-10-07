#!/usr/bin/env bash
# Claude Code status line: cwd | branch | model | ctx | rate limits | PR

input=$(cat)

# Unit-separator-delimited (not whitespace) so empty fields survive `read`
IFS=$'\x1f' read -r cwd model effort ctx h5 d7 spend pr_kind pr_num pr_state < <(
  echo "$input" | jq -r '[
    (.workspace.current_dir // .cwd // ""),
    (.model.display_name // ""),
    (.effort.level // ""),
    (.context_window.used_percentage // "" | if . == "" then "" else round end),
    (.rate_limits.five_hour.used_percentage // "" | if . == "" then "" else round end),
    (.rate_limits.seven_day.used_percentage // "" | if . == "" then "" else round end),
    (.rate_limits.spend_limit.used_percentage // "" | if . == "" then "" else round end),
    (.pr.kind // ""),
    (.pr.number // ""),
    (.pr.review_state // "")
  ] | map(tostring) | join("\u001f")'
)

R=$'\e[0m'; DIM=$'\e[2m'
BLUE=$'\e[34m'; MAGENTA=$'\e[35m'; CYAN=$'\e[36m'
GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'

# green < 50, yellow < 80, red otherwise
pct_color() {
  if   (( $1 >= 80 )); then printf '%s' "$RED"
  elif (( $1 >= 50 )); then printf '%s' "$YELLOW"
  else printf '%s' "$GREEN"; fi
}

parts=()

[[ -n $cwd ]] && parts+=("${BLUE}${cwd/#$HOME/\~}${R}")

if [[ -n $cwd ]]; then
  br=$(git -C "$cwd" --no-optional-locks symbolic-ref --short -q HEAD 2>/dev/null)
  [[ -n $br ]] && parts+=("${MAGENTA}${br}${R}")
fi

if [[ -n $model ]]; then
  m="${CYAN}${model}${R}"
  [[ -n $effort ]] && m+=" ${DIM}(${effort})${R}"
  parts+=("$m")
fi

[[ -n $ctx ]] && parts+=("$(pct_color "$ctx")ctx ${ctx}%${R}")

limits=()
[[ -n $h5    ]] && limits+=("$(pct_color "$h5")5h ${h5}%${R}")
[[ -n $d7    ]] && limits+=("$(pct_color "$d7")7d ${d7}%${R}")
[[ -n $spend ]] && limits+=("$(pct_color "$spend")spend ${spend}%${R}")
(( ${#limits[@]} )) && parts+=("${limits[*]}")

if [[ -n $pr_num ]]; then
  [[ $pr_kind == mr ]] && label="MR !${pr_num}" || label="PR #${pr_num}"
  case $pr_state in
    approved)          c=$GREEN ;;
    changes_requested) c=$RED ;;
    *)                 c=$YELLOW ;;
  esac
  [[ -n $pr_state ]] && label+=" (${pr_state})"
  parts+=("${c}${label}${R}")
fi

sep=" ${DIM}|${R} "
out=""
for p in "${parts[@]}"; do
  out+="${out:+$sep}$p"
done
printf '%s\n' "$out"

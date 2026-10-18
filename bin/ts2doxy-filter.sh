#!/bin/sh
# ts2doxy-filter.sh -- Doxygen input filter: ts2doxy with cache hits served
# from the shell.
#
# Takes the same arguments as bin/ts2doxy.js. When the filter cache holds a
# fresh translation of the file, this prints it without starting node (7 ms
# instead of 37 ms per file on a small project, 34 ms instead of 79 ms on one
# with 3279 files). Anything else -- no cache entry, a stale or
# locked one, an option this script does not know, a `stat` that is not GNU's,
# a missing tool -- goes to `node ts2doxy.js` with the arguments unchanged. So
# this script either prints exactly what node would print, or lets node do it.
#
# POSIX sh only. The freshness check is the one `src/cache.js` prepares for it:
# `xargs -0 stat -c '%s %.9Y' < shell.list` must print exactly `shell.snap`.

LC_ALL=C
export LC_ALL

here=${0%/*}
[ "$here" = "$0" ] && here=.

fallback() {
  exec node "$here/ts2doxy.js" "$@"
}

# --- arguments -------------------------------------------------------------

# The JSON key cache.js builds (`entryFor`) is rebuilt below, so the same entry
# is found. Values go into it verbatim, so a value that JSON.stringify would
# escape -- quotes, backslashes, control or non-ASCII bytes -- falls back.
project='' root='' nsmode='' nsname='' flags='' cachedir='' file=''
plain() {
  case $1 in
    *[!' '-~]* | *'"'* | *\\*) return 1 ;;
  esac
  return 0
}
# Sets the variables above from the arguments; fails on anything that only
# node can handle (--no-cache, --stats, --help, unknown options, empty values).
parse() {
  while [ $# -gt 0 ]; do
    case $1 in
      -p | --project | -r | --root | -n | --namespace-mode | --namespace-name | --cache-dir)
        [ $# -ge 2 ] && [ -n "$2" ] || return 1
        case $1 in
          -p | --project) project=$2 ;;
          -r | --root) root=$2 ;;
          -n | --namespace-mode) nsmode=$2 ;;
          --namespace-name) nsname=$2 ;;
          --cache-dir) cachedir=$2 ;;
        esac
        shift
        ;;
      --no-implicit-ctors) flags="$flags implicitCtors" ;;
      --no-virtual) flags="$flags virtualMethods" ;;
      --no-bodies) flags="$flags emitBodies" ;;
      --list-unresolved) flags="$flags listUnresolved" ;;
      --strict | -q | --quiet) ;;
      -*) return 1 ;;
      *)
        [ -z "$file" ] || return 1
        file=$1
        ;;
    esac
    shift
  done
  case $file in
    '' | pregen | report) return 1 ;;
  esac
  return 0
}
parse "$@" || fallback "$@"

# Absolute and already normalized, as node's path.resolve would make it.
absolute() {
  case $1 in
    /*) abs=$1 ;;
    *) abs=$PWD/$1 ;;
  esac
  case $abs in
    */./* | */../* | */. | */.. | *//* | */) return 1 ;;
  esac
  return 0
}

absolute "$file" || fallback "$@"
file=$abs
[ -f "$file" ] || fallback "$@"

# --- the cache entry -------------------------------------------------------

if [ -n "$project" ]; then
  absolute "$project" || fallback "$@"
  config=$abs
  [ -d "$config" ] && config=$config/tsconfig.json
else
  dir=${file%/*}
  config=''
  while :; do
    if [ -e "$dir/tsconfig.json" ]; then config=$dir/tsconfig.json; break; fi
    if [ -e "$dir/jsconfig.json" ]; then config=$dir/jsconfig.json; break; fi
    [ -z "$dir" ] && break
    dir=${dir%/*}
  done
  # At the top, "$dir" is empty and the names above are /tsconfig.json.
  case $config in /*) ;; *) fallback "$@" ;; esac
fi
[ -f "$config" ] || fallback "$@"

plain "$config" || fallback "$@"
key="{\"format\":2,\"config\":\"$config\""
if [ -n "$root" ]; then
  absolute "$root" && plain "$abs" || fallback "$@"
  key="$key,\"root\":\"$abs\""
fi
if [ -n "$nsmode" ]; then
  plain "$nsmode" || fallback "$@"
  key="$key,\"namespaceMode\":\"$nsmode\""
fi
if [ -n "$nsname" ]; then
  plain "$nsname" || fallback "$@"
  key="$key,\"namespaceName\":\"$nsname\""
fi
for flag in implicitCtors virtualMethods emitBodies; do
  case " $flags " in *" $flag "*) key="$key,\"$flag\":false" ;; esac
done
case " $flags " in *" listUnresolved "*) key="$key,\"listUnresolved\":true" ;; esac
key="$key}"

if [ -n "$cachedir" ]; then
  absolute "$cachedir" || fallback "$@"
  cache=$abs
elif [ -n "$XDG_CACHE_HOME" ]; then
  cache=$XDG_CACHE_HOME/ts2doxy
elif [ -n "$HOME" ]; then
  cache=$HOME/.cache/ts2doxy
else
  fallback "$@"
fi

entry=''
for candidate in "$cache"/*/key.json; do
  [ -f "$candidate" ] || continue
  stored=''
  IFS= read -r stored < "$candidate"
  if [ "$stored" = "$key" ]; then
    entry=${candidate%/key.json}
    break
  fi
done
[ -n "$entry" ] || fallback "$@"
[ -e "$entry/lock" ] && fallback "$@"

[ -f "$entry/current" ] || fallback "$@"
gen=''
IFS= read -r gen < "$entry/current" || [ -n "$gen" ] || fallback "$@"
case $gen in g-*) ;; *) fallback "$@" ;; esac
gen=$entry/$gen

# --- freshness -------------------------------------------------------------

out=$gen/tree$file.txt
[ -f "$out" ] && [ -f "$gen/shell.snap" ] && [ -f "$gen/shell.list" ] \
  && [ -f "$gen/shell.absent" ] || fallback "$@"
for tool in xargs stat cmp cat; do
  command -v "$tool" > /dev/null 2>&1 || fallback "$@"
done
while IFS= read -r gone; do
  [ -e "$gone" ] && fallback "$@"
done < "$gen/shell.absent"
xargs -0 stat -c '%s %.9Y' < "$gen/shell.list" 2> /dev/null \
  | cmp -s - "$gen/shell.snap" || fallback "$@"

# A newer generation may have replaced this one since; cat then fails to open
# the file (having printed nothing), and node takes over.
cat "$out" 2> /dev/null || fallback "$@"

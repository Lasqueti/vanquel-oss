# ios/tweak/Makefile
# Builds VanquelTweak with Theos (github.com/theos/theos). Run it on a Mac with
# Xcode, Theos and ldid installed. Normally scripts/phone/install-tweak.sh runs
# this for you.
#
#   make package FINALPACKAGE=1 LINE_NUMBER=+15550100123 SCHEME=rootless
#
# Variables:
#   THEOS        where Theos is installed (required, from your environment)
#   LINE_NUMBER  this line's own phone number in E.164 (required, no default).
#                Only used as the fallback creatorHandle of a native poll; the
#                tweak asks IMCore for the signed-in handle first.
#   SCHEME       rootless (palera1n rootless, Dopamine; installs under /var/jb)
#                or rootful (checkra1n, iOS 13; installs under /Library).
#                Default rootless.
#
# Every IMCore/IMDPersistence SPI is resolved at RUNTIME (NSClassFromString,
# NSInvocation), so the build SDK only has to satisfy Foundation/UIKit/
# CoreGraphics: SDK 15.6 builds for iOS 13 through 16. arm64 only.

ifndef THEOS
$(error THEOS is not set: export THEOS=<path to your Theos checkout>)
endif
ifndef LINE_NUMBER
$(error LINE_NUMBER is required, for example make LINE_NUMBER=+15550100123)
endif

SCHEME ?= rootless
ifeq ($(SCHEME),rootless)
export THEOS_PACKAGE_SCHEME = rootless
TARGET := iphone:clang:15.6:14.0
else ifeq ($(SCHEME),rootful)
TARGET := iphone:clang:15.6:13.0
else
$(error SCHEME must be rootless or rootful)
endif

ARCHS = arm64
INSTALL_TARGET_PROCESSES = SpringBoard

include $(THEOS)/makefiles/common.mk

TWEAK_NAME = VanquelTweak
VanquelTweak_FILES = Tweak.m
VanquelTweak_CFLAGS = -fobjc-arc -Wno-deprecated-declarations -DTWEAK_LINE_NUMBER='"$(LINE_NUMBER)"'
VanquelTweak_FRAMEWORKS = Foundation UIKit CoreGraphics
VanquelTweak_LIBRARIES = sqlite3

include $(THEOS)/makefiles/tweak.mk

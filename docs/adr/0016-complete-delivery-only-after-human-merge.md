# Complete delivery only after human merge

Creating a Delivery Pull Request will mark the result ready for owner attention but will not close its Work Issue or recovery chain. Only an owner merge reaches Delivered and closes the linked work; closing the pull request without merge enters Needs Decision and does not authorize an automatic retry. This leaves completed-looking Issues open longer in exchange for preserving the approved human merge boundary and accurately distinguishing a Verified Result from accepted delivery.

This is an issue/ticket project manager that sits on top of github.  It actually uses issues to track issues in a meta way.  Largely inspired by Huboard.

## Configuration ##
The first few settings of the configuration are self explanatory.  The other two sections are a bit tricky.

First is the ```trackers``` which is a list of the issue trackers that should be included in the overall project tracker.  Each project on github can list as many of it's repos as it wants and may designate which repo is the primary one to put the internal issues on.

Next is the ```states``` section.  This is a list of the states of the work board from left to right.  The ```label``` is what is used on the internal issues to designate the state and the ```title``` is for display purposes only.

